// Extracted from the production Hub; personal services and configuration removed.
const http = require('http');
const https = require('https');
const { WebSocketServer, WebSocket } = require('ws');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CLIENT_PORT = parseInt(process.env.BRIDGE_CLIENT_PORT) || 3462;
const BRIDGE_PORT = parseInt(process.env.BRIDGE_INTERNAL_PORT) || 3463;
const TMUX_SESSION = process.env.BRIDGE_TMUX || 'cc-session';
const TMUX_USER = process.env.BRIDGE_TMUX_USER || process.env.USER || 'root';
const AUTH_TOKEN = process.env.BRIDGE_AUTH_TOKEN || '';
if (!AUTH_TOKEN) throw new Error('BRIDGE_AUTH_TOKEN is required');
function okTok(t) { return typeof t === 'string' && t.length === AUTH_TOKEN.length &&
  crypto.timingSafeEqual(Buffer.from(t), Buffer.from(AUTH_TOKEN)); }
const PAGE_KEY = process.env.BRIDGE_PAGE_KEY || '';
const RUNTIME_DIR = process.env.BRIDGE_DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(RUNTIME_DIR, { recursive:true, mode:0o700 });
const UPLOAD_DIR = path.join(RUNTIME_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, {recursive:true,mode:0o700});

const HISTORY_FILE = path.join(RUNTIME_DIR, 'history.jsonl');

let clientIdCounter = 0;
let msgIdCounter = 0;
// Hub restarts must not reuse message IDs: clients deduplicate by these IDs.
try {
  for (const line of fs.readFileSync(HISTORY_FILE, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const m = JSON.parse(line);
      const n = /^([us])_(\d+)$/.exec(m.id || '');
      if (n) msgIdCounter = Math.max(msgIdCounter, Number(n[2]));
    } catch(e) {}
  }
} catch(e) {}
const clients = new Map();
let bridge = null;
let bridgeReady = false;
let ccAlive = false;
let ccBusy = false;
let busyTimer = null;

const CCTail = require('./cc-tail');
const ccTail = new CCTail();
var sseClients = new Set();

function log(msg) { console.log('[hub] ' + msg); }


function loadHistory() {
  try {
    return fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n')
      .filter(Boolean).map(l => { try { return JSON.parse(l); } catch(e) { return null; } }).filter(Boolean);
  } catch(e) { return []; }
}

var extOrigin = {}; var extOriginOrder = [];   // 外部来源消息 id -> source (external integrations), 见 /api/message
var extPending = { src: '', t: 0 };            // CC 的 reply 常不带 reply_to: the most recent external source event before the next web message的 reply 都算回给它的
var EXT_PENDING_MS = 180000;
// In-memory index of durable replies for poll fallback; sourced from disk on restart.
var durablePollReplies = loadHistory().filter(function(m) {
  return m.role === 'assistant' && !m.source && m.id && m.ts;
}).slice(-1200);
function appendHistory(msg) {
  fs.appendFileSync(HISTORY_FILE, JSON.stringify(msg) + '\n');
  if (msg.role === 'assistant' && !msg.source) {
    durablePollReplies.push(msg);
    if (durablePollReplies.length > 1200) durablePollReplies.shift();
  }
}

function nextMsgId(prefix) {
  return prefix + '_' + (++msgIdCounter);
}

var pollQueue = [];
var ccWaitQueue = [];  // CC重启间隙的待发消息 (bridge连回后补发)
var lastVisiblePoll = 0;  // 最近一次"可见前端"的轮询时间 (在场检测)
var POLL_MAX = 200;
function broadcast(data, exclude) {
  pollQueue.push({_t:Date.now(), d:data}); if(pollQueue.length>POLL_MAX)pollQueue.shift();
  var json = JSON.stringify(data);
  clients.forEach(function(c) {
    if (c !== exclude && c.ws.readyState === WebSocket.OPEN && c.authed) {
      c.ws.send(json);
    }
  });
}

function setBusy(val) {
  ccBusy = val;
  broadcast({ type: 'cc_busy', busy: val });
  if (busyTimer) { clearTimeout(busyTimer); busyTimer = null; }
  if (val) { busyTimer = setTimeout(function() { setBusy(false); }, 120000); }
}

// 多图 (2026-09-08): 接受 images[] 或单 image, 返回落盘路径数组
function saveImages(obj) {
  var list = Array.isArray(obj.images) && obj.images.length ? obj.images : (obj.image ? [obj.image] : []);
  var paths = [];
  list.forEach(function(im) {
    if (!im || !im.data || im.isText) return;
    try { paths.push(saveImage(im.data, im.type)); } catch(e) { log('image save error: ' + e.message); }
  });
  return paths;
}
function attachImagePaths(stored, meta, paths, content) {
  if (!paths.length) return content;
  stored.image_path = paths[0]; meta.image_path = paths[0];
  if (paths.length > 1) {
    stored.image_paths = paths; meta.image_paths = paths.join(',');
    content = (content || '') + ' [共' + paths.length + '张图片, 请逐张查看: ' + paths.join(' , ') + ']';
  }
  return content;
}
function saveImage(base64, mediaType) {
  var ext = (mediaType || '').split('/')[1] || 'png';
  if (ext === 'jpeg') ext = 'jpg';
  var name = 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6) + '.' + ext;
  var fpath = path.join(UPLOAD_DIR, name);
  fs.writeFileSync(fpath, Buffer.from(base64, 'base64'));
  return fpath;
}

// 聊天回复的PWA推送 (2026-08-16): 15秒内有可见前端在轮询就不推, 人在眼前不吵

function buildChannelText(content, meta) {
  var safe = content.replace(/\n/g, ' ');
  var attrKeys = ['chat_id', 'message_id', 'user', 'user_id', 'ts', 'image_path', 'image_paths', 'origin'];
  var attrs = attrKeys
    .filter(function(k) { return meta[k] != null; })
    .map(function(k) { return k + '="' + meta[k] + '"'; })
    .join(' ');
  return '<channel source="web" ' + attrs + ' reply_with="mcp__web-channel__reply">' + safe + '</channel>';
}

function forwardToCC(content, meta) {
  if (!ccAlive) {
    if (ccWaitQueue.length < 5) {
      ccWaitQueue.push({ content: content, meta: meta, t: Date.now() });
      log('CC未就绪, 消息入等待队列: ' + (meta.message_id || ''));
      return 'queued';
    }
    return false;
  }
  return injectCore(buildChannelText(content, meta), meta.message_id || null);
}

// Only API turns actually generated in the sending Classic conversation are eligible.
// Old unscoped log entries deliberately never fall back into a new conversation.
const apiSyncInbox = require('./api-sync-inbox')(path.join(RUNTIME_DIR, 'api-sync-inbox.json'));
const API_SYNC_FILE = path.join(RUNTIME_DIR, 'api-context-delivered.json');
var apiDelivered = {};
try { apiDelivered = JSON.parse(fs.readFileSync(API_SYNC_FILE, 'utf8')); } catch (e) {}
var apiPending = new Map();
function apiTurnKey(m) {
  return crypto.createHash('sha256').update(JSON.stringify([m.conversation_id, m.ts, m.user, m.assistant, m.via])).digest('hex');
}
function finishAPIContext(id, delivered) {
  var pending = apiPending.get(id);
  if (!pending) return;
  apiPending.delete(id);
  if (!delivered) return;
  pending.keys.forEach(function(k) { apiDelivered[k] = true; });
  try {
    fs.writeFileSync(API_SYNC_FILE + '.tmp', JSON.stringify(apiDelivered), {mode: 0o600});
    fs.renameSync(API_SYNC_FILE + '.tmp', API_SYNC_FILE);
  } catch (e) { log('API context delivery state save failed: ' + e.message); }
}
function fetchRecentAPI(conversationId, cb) {
  if (typeof conversationId !== 'string' || !conversationId.trim()) return cb([]);
  var done = false;
  function finish(logs) {
    if (done) return;
    done = true;
    var merged = new Map();
    apiSyncInbox.recent(conversationId).concat(logs).forEach(function(m) { merged.set(apiTurnKey(m), m); });
    cb(Array.from(merged.values()).sort(function(a,b) { return Date.parse(a.ts)-Date.parse(b.ts); }).slice(-50));
  }
  var req = http.get('http://127.0.0.1:' + (process.env.CHAT_PORT || '4500') + '/api/chat-log/recent?n=50&conversation_id=' + encodeURIComponent(conversationId), {
    headers: { 'x-auth-token': process.env.CHAT_PASSWORD || '' }
  }, function(res) {
    var body = '';
    res.on('data', function(c) { body += c; });
    res.on('error', function() { finish([]); });
    res.on('end', function() {
      try {
        var logs = JSON.parse(body);
        finish(res.statusCode === 200 && Array.isArray(logs) ? logs.filter(function(m) { return m.conversation_id === conversationId; }) : []);
      } catch(e) { finish([]); }
    });
  });
  req.on('error', function() { finish([]); });
  req.setTimeout(3000, function() { req.destroy(); finish([]); });
}
function forwardWithAPIContext(content, meta, conversationId, cb) {
  // Keep the lookup strictly scoped to the Classic conversation. Log only
  // identifiers/counts (never message text) so silent context misses are diagnosable.
  if (typeof conversationId !== 'string' || !conversationId.trim()) {
    log('API context skipped: missing conversation_id for ' + (meta.message_id || 'unknown message'));
    return cb(forwardToCC(content, meta));
  }
  fetchRecentAPI(conversationId, function(logs) {
    var reserved = new Set();
    apiPending.forEach(function(p, id) {
      if (Date.now() - p.t > 180000) { apiPending.delete(id); return; }
      p.keys.forEach(function(k) { reserved.add(k); });
    });
    var fresh = logs.filter(function(m) {
      var k = apiTurnKey(m);
      return m.conversation_id === conversationId && !apiDelivered[k] && !reserved.has(k);
    });
    log('API context lookup: cid=' + conversationId.slice(-8) + ' recent=' + logs.length + ' fresh=' + fresh.length + ' msg=' + (meta.message_id || 'unknown'));
    if (fresh.length) {
      var lines = [];
      fresh = fresh.slice(-4);
      fresh.forEach(function(m) {
        if (m.user) lines.push('User: ' + m.user.slice(0, 6000));
        if (m.assistant) lines.push((m.via === 'cli' ? '-pAssistant' : 'APIAssistant') + ': ' + m.assistant.slice(0, 6000));
      });
      content = '[当前窗口新增API/-p对话；限量阅读副本，不能视为完整原文]\n' + lines.join('\n').slice(-48000) + '\n[本次User消息]\n' + content;
      apiPending.set(meta.message_id, { keys: fresh.map(apiTurnKey), t: Date.now() });
    }
    var ok = forwardToCC(content, meta);
    log('API context forward: msg=' + (meta.message_id || 'unknown') + ' outcome=' + (ok === 'queued' ? 'queued' : (ok ? 'sent' : 'failed')));
    if (!ok) finishAPIContext(meta.message_id, false);
    cb(ok);
  });
}

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html':'text/html', '.css':'text/css', '.js':'application/javascript', '.json':'application/json',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.svg':'image/svg+xml', '.ico':'image/x-icon', '.webp':'image/webp' };

function serveStatic(req, res) {
  var url = req.url.split('?')[0];
  var qs = (req.url.split('?')[1] || '');
  var params = new URLSearchParams(qs);
  if (url === '/') url = '/index.html';
  if (url === '/index.html' && params.get('k') !== PAGE_KEY) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('access denied');
    return true;
  }
  if (url.startsWith('/uploads/')) {
    var fp = path.join(UPLOAD_DIR, path.basename(url));
    if (fs.existsSync(fp)) {
      var ext = path.extname(fp).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      fs.createReadStream(fp).pipe(res);
      return true;
    }
  }
  var fp = path.join(PUBLIC_DIR, url);
  if (!fp.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return true; }
  if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    var ext = path.extname(fp).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(fp).pipe(res);
    return true;
  }
  return false;
}


// === CC Control & Ask state machine (additive 2026-08-15) ===
// 铁律: 只注入白名单键/预设整句; 打断用 Escape, 严禁 C-c
var SEND_LOCK = false;
var askState = { active: false, prompt: '', options: [], sig: '', cursor: 1 };
var newSessionPending = false;
var CC_MODELS = { opus: 1, sonnet: 1, haiku: 1 };
var CC_KEYS = { Up: 1, Down: 1, Enter: 1, Escape: 1, Tab: 1, BTab: 1, BSpace: 1, 'C-u': 1 };   // 20260905 终端镜像多了 Tab/⇧Tab/退格/清行

function sseWrite(obj) {
  var data = 'data: ' + JSON.stringify(obj) + '\n\n';
  sseClients.forEach(function(res) {
    try { res.write(data); } catch (e) { sseClients.delete(res); }
  });
}

function withSendLock(fn) {
  if (SEND_LOCK) return false;
  SEND_LOCK = true;
  try { return fn(); } finally { SEND_LOCK = false; }
}

function injectKeys(keys) {
  try {
    execFileSync('sudo', ['-u', TMUX_USER, 'tmux', 'send-keys', '-t', TMUX_SESSION + ':0'].concat(keys), { timeout: 3000 });
    return true;
  } catch (e) { log('injectKeys failed: ' + e.message); return false; }
}

function injectLine(text) {
  return injectCore(text, null);
}

function capturePane() {
  try {
    return execFileSync('sudo', ['-u', TMUX_USER, 'tmux', 'capture-pane', '-p', '-t', TMUX_SESSION + ':0'], { timeout: 3000 }).toString();
  } catch (e) { return null; }
}

// === 注入可靠性核心 (2026-08-16) ===
// 病根: 文字注入后立刻发Enter, CC的TUI没就绪时Enter被吞, 消息卡在输入框里
// 方案: 就绪等待 + 空闲时清残留 + 文字与Enter之间留间隔 + (聊天消息)jsonl落盘验证补发
function _tmuxSend(args) {
  execFileSync('sudo', ['-u', TMUX_USER, 'tmux', 'send-keys', '-t', TMUX_SESSION + ':0'].concat(args), { timeout: 3000 });
}
function _sleepMs(ms) { try { execFileSync('sleep', [String(ms / 1000)]); } catch (e) {} }

function _paneReady(pane) {
  if (!pane) return false;
  return pane.indexOf('⏵⏵') >= 0 || pane.indexOf('esc to interrupt') >= 0 ||
         pane.indexOf('? for shortcuts') >= 0 || /Context\s.*\d+%/.test(pane);
}
function _paneBusy(pane) { return !!pane && pane.indexOf('esc to interrupt') >= 0; }

// 输入框残留: 底部区域有 "❯ 文字" 且上下夹在横线边框之间
// (注意: capture-pane可能拿到未重绘的旧帧, 所以这个判定只用于"顺手清一下", 不作强依据)
function _inputResidual(pane) {
  if (!pane) return false;
  var lines = pane.split('\n');
  for (var i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
    if (/^❯\s+\S/.test(lines[i])) {
      var hasTop = false, hasBot = false;
      for (var a = Math.max(0, i - 3); a < i; a++) if (lines[a].indexOf('────') >= 0) hasTop = true;
      for (var b = i + 1; b < Math.min(lines.length, i + 4); b++) if (lines[b].indexOf('────') >= 0) hasBot = true;
      if (hasTop && hasBot) return true;
    }
  }
  return false;
}

// verifyId 非空 = 聊天消息: 异步验证channel标签里的message_id是否落进会话jsonl,
// 没落盘就补一次Enter再验, 仍失败广播 cc_send_fail 让前端提示重发.
// verifyId 空 = 斜杠命令/nudge: 550ms后无条件补一个Enter (若已提交, 空输入Enter是no-op)
function injectCore(text, verifyId) {
  var safe = String(text).replace(/[\r\n]/g, ' ');
  try {
    var pane = capturePane();
    var waited = 0;
    while (!_paneReady(pane) && waited < 9000) { _sleepMs(600); waited += 600; pane = capturePane(); }
    if (!_paneReady(pane)) log('inject: TUI仍未就绪(9s), 硬着头皮注入');
    if (pane && !_paneBusy(pane) && _inputResidual(pane)) {
      log('inject: 输入框疑似有残留, Escape清一下');
      _tmuxSend(['Escape']);
      _sleepMs(300);
    }
    _tmuxSend(['-l', safe]);
    _sleepMs(350);
    _tmuxSend(['Enter']);
  } catch (e) { log('inject failed: ' + e.message); return false; }
  if (verifyId) {
    _scheduleVerify(verifyId, 1);
  } else {
    setTimeout(function() { try { _tmuxSend(['Enter']); } catch (e) {} }, 550);
  }
  return true;
}

function _jsonlHas(id) {
  try {
    var f = ccTail.findCurrentSession();
    if (!f) return false;
    var st = fs.statSync(f);
    var start = Math.max(0, st.size - 200000);
    var buf = Buffer.alloc(st.size - start);
    var fd = fs.openSync(f, 'r');
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    var s = buf.toString('utf8');
    return s.indexOf('message_id=\\"' + id + '\\"') >= 0 || s.indexOf('message_id="' + id + '"') >= 0;
  } catch (e) { return false; }
}

function _scheduleVerify(id, attempt) {
  setTimeout(function() {
    if (_jsonlHas(id)) { finishAPIContext(id, true); return; }
    if (attempt === 1) {
      log('inject verify: ' + id + ' 未落盘, 补发Enter');
      try { _tmuxSend(['Enter']); } catch (e) {}
      _scheduleVerify(id, 2);
    } else {
      finishAPIContext(id, false);
      log('inject verify FAILED: ' + id);
      var evt = { type: 'cc_send_fail', id: id };
      broadcast(evt); sseWrite(evt);
      setBusy(false);
    }
  }, 2500);
}

// 菜单判定: 连续编号选项块(从1起,>=2项), 且 ❯ 落在选项行上;
// 或选项块上方近处有 Do you want 类询问语. 单独的 ❯ 是CC输入框提示符, 不算.
function parseAskMenu(pane) {
  var lines = pane.split('\n');
  var blocks = [], cur = null;
  var start = Math.max(0, lines.length - 45);
  for (var i = start; i < lines.length; i++) {
    var clean = lines[i].replace(/[─-╿]/g, ' ');
    var m = clean.match(/^\s*(❯)?\s*(\d{1,2})[.)]\s+(.+?)\s*$/);
    if (m) {
      var num = parseInt(m[2], 10);
      if (cur && num === cur.options.length + 1) {
        cur.options.push({ index: num, label: m[3].trim().slice(0, 140) });
        if (m[1]) cur.cursor = num;
        continue;
      }
      if (num === 1) {
        cur = { line: i, options: [{ index: 1, label: m[3].trim().slice(0, 140) }], cursor: m[1] ? 1 : 0 };
        blocks.push(cur);
        continue;
      }
    }
    if (cur && clean.trim() !== '') cur = null;
  }
  var best = null;
  for (var b = 0; b < blocks.length; b++) {
    var blk = blocks[b];
    if (blk.options.length < 2) continue;
    if (blk.cursor) { best = blk; continue; }
    var above = lines.slice(Math.max(0, blk.line - 8), blk.line).join('\n');
    if (/Do you want|Would you like|Trust the files|Allow this/i.test(above)) best = blk;
  }
  if (!best) return null;
  var prompt = [];
  for (var j = best.line - 1, took = 0; j >= 0 && took < 3 && best.line - j < 10; j--) {
    var t = lines[j].replace(/[─-╿]/g, ' ').trim();
    if (t) { prompt.unshift(t); took++; }
    else if (prompt.length) break;
  }
  return { prompt: prompt.join('\n').slice(0, 600), options: best.options, cursor: best.cursor || 1 };
}

function checkAskMenu() {
  var pane = capturePane();
  if (pane == null) return;
  var parsed = parseAskMenu(pane);
  if (parsed) {
    var sig = parsed.prompt + '|' + parsed.options.map(function(o) { return o.label; }).join('|');
    askState.cursor = parsed.cursor;
    if (!askState.active || askState.sig !== sig) {
      askState.active = true;
      askState.sig = sig;
      askState.prompt = parsed.prompt;
      askState.options = parsed.options;
      var evt = { type: 'cc_ask', prompt: parsed.prompt, options: parsed.options };
      broadcast(evt); sseWrite(evt);
      log('cc_ask: ' + parsed.options.length + ' options');
    }
  } else if (askState.active) {
    askState.active = false; askState.sig = ''; askState.options = [];
    broadcast({ type: 'cc_ask_end' }); sseWrite({ type: 'cc_ask_end' });
    log('cc_ask_end');
  }
}

// 新会话 = 注入 /exit; start-cc.sh 的 while 循环会在5秒后自动拉起新CC.
// 这里只等新 JSONL 出现后让 cc-tail 跟上, 不杀任何进程.
function startNewSession() {
  if (newSessionPending) return false;
  var prevFile = ccTail._file;
  var ok = withSendLock(function() { return injectLine('/exit'); });
  if (!ok) return false;
  newSessionPending = true;
  var tries = 0;
  var timer = setInterval(function() {
    tries++;
    var cur = ccTail.findCurrentSession();
    if (cur && cur !== prevFile) {
      clearInterval(timer); newSessionPending = false;
      ccTail.switchSession();  // 内部emit('switch') → 统一广播cc_session_new
      log('new session: ' + path.basename(cur).replace('.jsonl', ''));
    } else if (tries > 60) {
      clearInterval(timer); newSessionPending = false;
      log('new_session: timeout waiting for new jsonl');
    }
  }, 3000);
  return true;
}

// --- Client WebSocket server ---
var clientServer = http.createServer(function(req, res) {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', clients: clients.size, cc_alive: ccAlive, busy: ccBusy }));
    return;
  }
  if (req.url.startsWith("/api/poll")) {
    if (!okTok(req.headers['x-auth-token'])) { res.writeHead(403);res.end();return; }
    if (req.url.indexOf('vis=1') >= 0) lastVisiblePoll = Date.now();
    var since = 0; try { since = parseInt(req.url.split("since=")[1]) || 0; } catch(e) {}
    var msgs = pollQueue.filter(function(m){return m._t >= since;}).map(function(m){return m.d;});
    // If the transient queue overflows during a burst, replay durable replies
    // within the requested window. Existing client-side ID dedup still applies.
    var included = new Set(msgs.filter(function(m){return m.type === 'message' && m.id;}).map(function(m){return m.id;}));
    durablePollReplies.forEach(function(m) {
      if (Date.parse(m.ts) >= since && !included.has(m.id)) {
        msgs.push(Object.assign({type:'message'},m));
        included.add(m.id);
      }
    });
    res.writeHead(200, {"Content-Type":"application/json","Access-Control-Allow-Origin":"*"});
    res.end(JSON.stringify({ok:true, cc_alive:ccAlive, busy:ccBusy, messages:msgs, t:Date.now()}));
    return;
  }
  if (req.url === '/api/api-context' && req.method === 'POST') {
    if (!okTok(req.headers['x-auth-token'])) { res.writeHead(403); res.end('forbidden'); return; }
    req.setEncoding('utf8');
    var contextBody = ''; var contextTooLarge = false;
    req.on('data', function(chunk) {
      if (contextTooLarge) return;
      contextBody += chunk;
      if (Buffer.byteLength(contextBody) > 2 * 1024 * 1024) { contextTooLarge = true; contextBody = ''; }
    });
    req.on('end', function() {
      if (contextTooLarge) { res.writeHead(413); res.end('too large'); return; }
      try {
        var accepted = apiSyncInbox.accept(JSON.parse(contextBody));
        res.writeHead(accepted ? 200 : 400, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:accepted, context_only:true}));
      } catch (e) { res.writeHead(400); res.end('bad context'); }
    });
    return;
  }
  if (req.url === "/api/message" && req.method === "POST") {
    if (!okTok(req.headers['x-auth-token'])) { res.writeHead(403);res.end();return; }
    if (askState.active) { res.writeHead(409, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "ask_pending" })); return; }
    var body = "";
    req.on("data", function(c) { body += c; });
    req.on("end", function() {
      try {
        var data = JSON.parse(body);
        var content = (data.content || "").trim();
        var imagePaths = saveImages(data);
        if (!content && !imagePaths.length) { res.writeHead(400); res.end("empty"); return; }
        var msgId = nextMsgId("u");
        var stored = { id: msgId, role: "user", content: content || "(image)", ts: new Date().toISOString() };
        var fwdMeta = { chat_id: "poll", message_id: msgId, user: "chat-user", ts: stored.ts };
        var fwdContent = attachImagePaths(stored, fwdMeta, imagePaths, content || "(image)");
        // 2026-09-17: 外部来源 (meta.source = external integrations ...): 只转给 CC, 不进 history, 不广播成User的气泡;
        //             回复走 reply_to 反查来源, 同样不进 history (classic 只留the user在 chat 里打的 + CC 的活动)
        var extSrc = (data.meta && data.meta.source && String(data.meta.source) !== 'web') ? String(data.meta.source).replace(/[^a-z0-9_-]/gi, '').slice(0, 24) : '';
        if (extSrc) {
          extOrigin[msgId] = extSrc; extOriginOrder.push(msgId); if (extOriginOrder.length > 200) delete extOrigin[extOriginOrder.shift()];
          fwdMeta.origin = extSrc;
          extPending = { src: extSrc, t: Date.now() };
          var okx = forwardToCC(fwdContent, fwdMeta);
          if (okx) setBusy(true);
          log('ext message from ' + extSrc + ' -> CC (' + msgId + ', 不进history)');
          res.writeHead(200, {"Content-Type":"application/json"});
          res.end(JSON.stringify({ok:!!okx, id:msgId}));
          return;
        }
        extPending = { src: '', t: 0 };
        rememberClassicRoute(data.conversation_id, msgId);
        appendHistory(stored);
        broadcast({ type: "message", role: "user", id: msgId, content: stored.content, ts: stored.ts }, null);
        var forward = data.cc_sync === true ? forwardWithAPIContext : function(content, meta, cid, done) { done(forwardToCC(content, meta)); };
        forward(fwdContent, fwdMeta, data.conversation_id, function(ok) {
          if (ok) setBusy(true);
          res.writeHead(200, {"Content-Type":"application/json"});
          res.end(JSON.stringify({ok:!!ok, id:msgId}));
        });
      } catch(e) { res.writeHead(400); res.end("bad json"); }
    });
    return;
  }
  if (req.url === '/api/recent') {
    if (!okTok(req.headers['x-auth-token'])) { res.writeHead(403);res.end();return; }
    var history = loadHistory().slice(-30);
    var recent = history.slice(-20);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(recent));
    return;
  }
  if (req.url === '/api/thinking' && req.method === 'POST') {
    if (!okTok(req.headers['x-auth-token'])) { res.writeHead(403);res.end();return; }
    var body = '';
    req.on('data', function(c) { body += c; });
    req.on('end', function() {
      try {
        var data = JSON.parse(body);
        if (data.content) {
          broadcast({ type: 'cc_thinking', content: data.content });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(400);
          res.end('missing content');
        }
      } catch(e) {
        res.writeHead(400);
        res.end('invalid json');
      }
    });
    return;
  }
  // --- CC Context Monitor ---
  // No static frontend served by the portable Hub; use chat-server instead.
  res.writeHead(404);
  res.end();
});

var clientWss = new WebSocketServer({ server: clientServer, maxPayload: 16 * 1024 * 1024 });

clientWss.on('connection', function(ws, req) {
  var id = 'c_' + (++clientIdCounter);
  var client = { ws: ws, id: id, authed: false };
  clients.set(id, client);
  var cip = req.headers['x-real-ip'] || req.socket.remoteAddress; log('client connected: ' + id + ' ip=' + cip);

  // ws.send(JSON.stringify({ type: 'auth_required' }));

  ws.on('message', function(raw) {
    var msg;
    try { msg = JSON.parse(raw); } catch(e) { log('parse fail from ' + id + ' (payload omitted)'); return; }

    if (msg.type === "pong") return;
    if (!client.authed) {
      log('auth attempt from ' + id + ': type=' + msg.type + ' hasToken=' + !!msg.token);
      if (msg.type === 'auth' && msg.token === AUTH_TOKEN) {
        client.authed = true;
        log('auth OK for ' + id);
        ws.send(JSON.stringify({ type: 'auth_ok', client_id: id, cc_alive: ccAlive }));
        var history = loadHistory().slice(-30);
        // ws.send(JSON.stringify({ type: 'history', messages: history }));
      } else {
        log('auth FAIL for ' + id + ' (credential omitted)');
        ws.send(JSON.stringify({ type: 'auth_fail', message: 'invalid token' }));
      }
      return;
    }

    if (msg.type === 'message') {
      var content = (msg.content || '').trim();
      if (!content && !msg.image && !(msg.images && msg.images.length)) return;
      var imagePaths = saveImages(msg);
      var msgId = nextMsgId('u');
      var stored = { id: msgId, role: 'user', content: content || '(image)', ts: new Date().toISOString() };
      var fwdMeta = { chat_id: id, message_id: msgId, user: 'chat-user', user_id: id, ts: stored.ts };
      var fwdContent = attachImagePaths(stored, fwdMeta, imagePaths, content || '(image)');
      extPending = { src: '', t: 0 };
      rememberClassicRoute(msg.conversation_id, msgId);
      appendHistory(stored);
      broadcast({ type: 'message', ...stored }, null);

      forwardWithAPIContext(fwdContent, fwdMeta, msg.conversation_id, function(ok) {
        if (ok) { setBusy(true); } else { ws.send(JSON.stringify({ type: 'error', message: 'CC is offline' })); }
      });
    }
  });

  ws.on('close', function(code, reason) {
    clients.delete(id);
    log('client disconnected: ' + id + ' code=' + code + ' reason=' + (reason || ''));
  });

  var hb = setInterval(function() { if (ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify({type:"ping",t:Date.now()})); } catch(e) {} } }, 20000);
  ws.on('close', function() { clearInterval(hb); });
});

clientServer.listen(CLIENT_PORT, '127.0.0.1', function() {
  log('client ws on 127.0.0.1:' + CLIENT_PORT);
});

// --- Bridge WebSocket server (internal, for MCP bridge) ---
var bridgeServer = http.createServer();
var bridgeWss = new WebSocketServer({ server: bridgeServer });

bridgeWss.on('connection', function(ws) {
  if (bridge && bridge.readyState === WebSocket.OPEN) {
    bridge.close(1000, 'replaced');
  }
  bridge = ws;
  bridgeReady = true;
  ccAlive = true;
  broadcast({ type: 'cc_status', alive: true });
  log('bridge connected');
  if (ccWaitQueue.length) {
    setTimeout(function() {
      var flushed = 0;
      while (ccWaitQueue.length) {
        var q = ccWaitQueue.shift();
        if (Date.now() - q.t > 180000) { finishAPIContext(q.meta.message_id, false); continue; }  // 超过3分钟的不补发
        if (!injectCore(buildChannelText(q.content, q.meta), (q.meta && q.meta.message_id) || null)) finishAPIContext(q.meta.message_id, false);
        flushed++;
      }
      if (flushed) { log('等待队列补发 ' + flushed + ' 条'); setBusy(true); }
    }, 2500);
  }

  ws.on('message', function(raw) {
    var msg;
    try { msg = JSON.parse(raw); } catch(e) { return; }

    if (msg.type === 'reply') {
      var text = msg.text || '';
      var thinking = msg.thinking || '';
      var toolsUsed = msg.tools_used || [];

      // Parse thinking from text prefix: <<THINKING>>...<<END_THINKING>>
      var tkMatch = text.match(/^<<THINKING>>([\s\S]*?)<<END_THINKING>>\s*/);
      if (tkMatch) {
        thinking = tkMatch[1].trim();
        text = text.slice(tkMatch[0].length);
      }

      // Parse tools from text prefix: <<TOOLS>>JSON<<END_TOOLS>>
      var tlMatch = text.match(/^<<TOOLS>>([\s\S]*?)<<END_TOOLS>>\s*/);
      if (tlMatch) {
        try { toolsUsed = JSON.parse(tlMatch[1]); } catch(e) {}
        text = text.slice(tlMatch[0].length);
      }

      if (toolsUsed.length > 0) {
        toolsUsed.forEach(function(t) {
          broadcast({ type: 'cc_tool', name: t.name, args: t.args || '', result: t.result || '' });
        });
      }
      if (thinking) {
        broadcast({ type: 'cc_thinking', content: thinking });
      }
      var msgId = nextMsgId('s');
      var stored = { id: msgId, role: 'assistant', content: text, ts: new Date().toISOString() };
      if (msg.reply_to) stored.reply_to = msg.reply_to;
      if (thinking) stored.thinking = thinking;
      var replySrc = (msg.reply_to && extOrigin[msg.reply_to]) || '';
      if (!replySrc && extPending.src && Date.now() - extPending.t < EXT_PENDING_MS) { replySrc = extPending.src; extPending.t = Date.now(); }
      if (replySrc) { stored.source = replySrc; log('reply to ext ' + replySrc + ' (' + (msg.reply_to || 'pending') + '), 不进history'); }
      else { appendHistory(stored); persistClassicReply(stored); }
      broadcast({ type: 'message', ...stored });
      setBusy(false);

      if (msg._req_id) {
        ws.send(JSON.stringify({ _req_id: msg._req_id, ok: true, id: msgId }));
      }
    } else if (msg.type === 'edit') {
      if (msg._req_id) {
        ws.send(JSON.stringify({ _req_id: msg._req_id, ok: true }));
      }
    }
  });

  ws.on('close', function() {
    bridgeReady = false;
    ccAlive = false;
    bridge = null;
    broadcast({ type: 'cc_status', alive: false });
    log('bridge disconnected');
  });
});

bridgeServer.listen(BRIDGE_PORT, '127.0.0.1', function() {
  log('bridge ws on 127.0.0.1:' + BRIDGE_PORT);
});

// --- Reliable CC -> Classic server persistence (2026-11-14) ---
// A CC reply is durable in the hub history, but older clients may miss the
// transient WebSocket/poll event. Append it to the Classic conversation server
// independently of client delivery; stream-index deduplicates client replays.
const CLASSIC_ROUTE_FILE = path.join(RUNTIME_DIR, 'classic-active-conversation.json');
var classicRoute = { cid: '', t: 0 };
var classicReplyRoutes = new Map();
try {
  var _cr = JSON.parse(fs.readFileSync(CLASSIC_ROUTE_FILE, 'utf8'));
  if (_cr && typeof _cr.cid === 'string' && /^c_[a-zA-Z0-9_-]+$/.test(_cr.cid)) classicRoute = _cr;
} catch(e) {}
function rememberClassicRoute(cid, msgId) {
  if (typeof cid !== 'string' || !/^c_[a-zA-Z0-9_-]+$/.test(cid)) return;
  classicRoute = { cid: cid, t: Date.now() };
  if (msgId) {
    classicReplyRoutes.set(msgId, { cid: cid, t: Date.now() });
    if (classicReplyRoutes.size > 500) classicReplyRoutes.delete(classicReplyRoutes.keys().next().value);
  }
  try {
    fs.writeFileSync(CLASSIC_ROUTE_FILE + '.tmp', JSON.stringify(classicRoute), {mode:0o600});
    fs.renameSync(CLASSIC_ROUTE_FILE + '.tmp', CLASSIC_ROUTE_FILE);
  } catch(e) { log('classic route save failed: ' + e.message); }
}
function persistClassicReply(stored) {
  if (stored.source && stored.source !== 'web') return;
  var mapped = stored.reply_to && classicReplyRoutes.get(stored.reply_to);
  // Never attribute a reply to a conversation without a recent web route.
  var route = mapped || classicRoute;
  if (!route.cid || Date.now() - route.t > 24*3600*1000) {
    log('classic persistence skipped: no recent conversation for ' + stored.id);
    return;
  }
  var payload = JSON.stringify({cid:route.cid,m:{role:'assistant',content:stored.content,ts:Date.parse(stored.ts),source:'cc',bridge_id:stored.id,...(stored.thinking?{thinking:stored.thinking}:{})}});
  function attempt(n) {
    var req = http.request({host:'127.0.0.1',port:Number(process.env.CHAT_PORT || 4500),path:'/api/stream/append',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload),'x-auth-token':process.env.CHAT_PASSWORD || ''}},function(res){
      var b='';res.on('data',function(c){b+=c;});res.on('end',function(){
        if(res.statusCode===200){log('classic persisted ' + stored.id + ' cid=' + route.cid.slice(-8));return;}
        log('classic persistence HTTP ' + res.statusCode + ' for ' + stored.id);
        if(n<3 && res.statusCode>=500) setTimeout(function(){attempt(n+1)},1000*n);
      });
    });
    req.on('error',function(e){log('classic persistence error ' + stored.id + ': ' + e.message);if(n<3)setTimeout(function(){attempt(n+1)},1000*n);});
    req.setTimeout(5000,function(){req.destroy(new Error('timeout'));});
    req.end(payload);
  }
  attempt(1);
}

// --- CC JSONL Tail (real-time CC output) ---
ccTail.on('entry', function(entry) {
  broadcast({ type: 'cc_live', entry: entry });
  var data = 'data: ' + JSON.stringify(entry) + '\n\n';
  sseClients.forEach(function(res) {
    try { res.write(data); } catch(e) { sseClients.delete(res); }
  });
});

ccTail.on('switch', function(file) {
  var evt = { type: 'cc_session_new', session: path.basename(file).replace('.jsonl', '') };
  broadcast(evt); sseWrite(evt);
  log('cc-tail switched: ' + evt.session);
});

ccTail.start();
ccTail.startAutoSync();
log('cc-tail started: ' + (ccTail._file ? path.basename(ccTail._file) : 'no session'));

// === CC mode additions: SSE心跳 + ask菜单轮询 (additive 2026-08-15) ===
setInterval(function() {
  sseClients.forEach(function(res) {
    try { res.write(': ping\n\n'); } catch (e) { sseClients.delete(res); }
  });
}, 25000);

var lastEntryTs = 0;
ccTail.on('entry', function() { lastEntryTs = Date.now(); });

setInterval(function() {
  try {
    if (ccBusy || askState.active || (Date.now() - lastEntryTs < 90000)) checkAskMenu();
  } catch (e) { log('askPoll error: ' + e.message); }
}, 1200);

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
function shutdown() {
  log('shutting down...');
  ccTail.stop();
  clients.forEach(function(c) { c.ws.close(); });
  if (bridge) bridge.close();
  clientServer.close();
  bridgeServer.close();
  setTimeout(function() { process.exit(0); }, 1000);
}
