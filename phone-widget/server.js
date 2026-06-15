/**
 * Phone Widget Chat Server
 *
 * Two-port architecture:
 *   CLIENT_PORT  (4600) — serves static files + HTTP API + WebSocket for browser clients
 *   BRIDGE_PORT  (4601) — internal WebSocket for MCP bridge (Claude Code sends replies here)
 *
 * No Express dependency — raw Node.js http + ws.
 *
 * 双模式支持:
 *   CC 模式   — 通过 WebSocket + tmux 转发给 Claude Code
 *   API 模式  — 直接调用 Anthropic / OpenAI 兼容接口 (SSE 流式)
 */

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

/* ============================================================
 *  CUSTOMIZE: environment / config
 * ============================================================ */

// Load .env file if present (simple key=value parser, no dependency)
(function loadEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(function (line) {
      line = line.trim();
      if (!line || line.startsWith('#')) return;
      const eq = line.indexOf('=');
      if (eq < 1) return;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = val;
    });
  } catch (e) { /* silent */ }
})();

const CLIENT_PORT  = parseInt(process.env.CLIENT_PORT)  || 4600;
const BRIDGE_PORT  = parseInt(process.env.BRIDGE_PORT)   || 4601;

/* CUSTOMIZE: set an auth token to protect your WebSocket. Leave empty to disable auth. */
const AUTH_TOKEN   = process.env.AUTH_TOKEN || '';

/* CUSTOMIZE: tmux session name where Claude Code is running (used by forwardToCC) */
const TMUX_SESSION = process.env.TMUX_SESSION || 'cc';

/* CUSTOMIZE: name used in the channel tag forwarded to Claude Code */
const USER_NAME    = process.env.USER_NAME || 'user';

const HISTORY_FILE = path.join(__dirname, 'data', 'history.jsonl');
const CONFIG_FILE  = path.join(__dirname, 'data', 'config.json');
const PUBLIC_DIR   = path.join(__dirname, 'public');

// 默认配置 — 首次启动时写入
const DEFAULT_CONFIG = {
  providers: [
    {
      name: 'Anthropic',
      endpoint: 'https://api.anthropic.com/v1/messages',
      key: '',
      model: 'claude-opus-4-5',
      active: true
    },
    {
      name: 'OpenAI-compatible',
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      key: '',
      model: '',
      active: false
    }
  ],
  system_prompt: ''
};

// Ensure data directory exists
try { fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true }); } catch (e) {}

// 写入默认 config (仅首次)
if (!fs.existsSync(CONFIG_FILE)) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
  console.log('[hub] 已创建默认 config.json');
}

/* ============================================================
 *  State
 * ============================================================ */

let clientIdCounter = 0;
let msgIdCounter    = 0;
const clients       = new Map();
let bridge          = null;
let bridgeReady     = false;
let ccAlive         = false;
let ccBusy          = false;
let busyTimer       = null;

function log(msg) { console.log('[hub] ' + msg); }

/* ============================================================
 *  配置读写
 * ============================================================ */

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (e) { return JSON.parse(JSON.stringify(DEFAULT_CONFIG)); }
}

function saveConfig(obj) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(obj, null, 2));
}

/* ============================================================
 *  API 模式 — 工具函数
 * ============================================================ */

function normalizeEndpoint(url) {
  url = url.replace(/\/+$/, '');
  if (!url.endsWith('/chat/completions') && !url.endsWith('/messages')) {
    url += '/chat/completions';
  }
  return url;
}

function toAnthropicEndpoint(endpoint) {
  let url = endpoint.replace(/\/+$/, '');
  url = url.replace(/\/chat\/completions$/, '');
  if (!url.endsWith('/v1/messages')) {
    url = url.replace(/\/v1$/, '') + '/v1/messages';
  }
  return url;
}

// SSE 行读取器 (node-fetch body 是 Node.js stream)
async function* readSSELines(body) {
  let buffer = '';
  for await (const chunk of body) {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      yield line;
    }
  }
  if (buffer.trim()) yield buffer;
}

// OpenAI 兼容格式流式请求
async function streamOpenAI(provider, messages, sendEvent) {
  const chatUrl = normalizeEndpoint(provider.endpoint);
  const reqBody = {
    model: provider.model,
    messages: messages,
    stream: true
  };

  const r = await fetch(chatUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + provider.key
    },
    body: JSON.stringify(reqBody)
  });

  if (!r.ok) {
    const errText = await r.text();
    let errMsg;
    try { errMsg = JSON.parse(errText).error?.message || errText; } catch (e) { errMsg = errText; }
    throw new Error('API ' + r.status + ': ' + errMsg);
  }

  let fullContent = '';

  for await (const line of readSSELines(r.body)) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]') break;

    let parsed;
    try { parsed = JSON.parse(data); } catch (e) { continue; }

    const delta = parsed.choices?.[0]?.delta;
    if (!delta) continue;

    if (delta.content) {
      fullContent += delta.content;
      sendEvent('content', { content: delta.content });
    }
  }

  return { content: fullContent };
}

// Anthropic 原生格式流式请求
async function streamAnthropic(provider, systemPrompt, messages, sendEvent) {
  const reqBody = {
    model: provider.model,
    max_tokens: 4096,
    messages: messages,
    stream: true
  };
  if (systemPrompt) reqBody.system = systemPrompt;

  const endpoint = toAnthropicEndpoint(provider.endpoint);
  const isNative = provider.endpoint.includes('anthropic.com');

  const r = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(isNative
        ? { 'x-api-key': provider.key }
        : { 'Authorization': 'Bearer ' + provider.key }),
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(reqBody)
  });

  if (!r.ok) {
    const errText = await r.text();
    let errMsg;
    try { errMsg = JSON.parse(errText).error?.message || errText; } catch (e) { errMsg = errText; }
    throw new Error('API ' + r.status + ': ' + errMsg);
  }

  const contentBlocks = [];
  let currentBlockIdx = -1;
  let fullContent = '';

  for await (const line of readSSELines(r.body)) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();

    let parsed;
    try { parsed = JSON.parse(data); } catch (e) { continue; }

    switch (parsed.type) {
      case 'content_block_start': {
        currentBlockIdx = parsed.index;
        const block = parsed.content_block;
        if (block.type === 'text') {
          contentBlocks[currentBlockIdx] = { type: 'text', text: '' };
        } else if (block.type === 'thinking') {
          contentBlocks[currentBlockIdx] = { type: 'thinking', thinking: '' };
          sendEvent('thinking_start', {});
        }
        break;
      }
      case 'content_block_delta': {
        const idx = parsed.index;
        const delta = parsed.delta;
        if (delta.type === 'text_delta' && contentBlocks[idx]?.type === 'text') {
          contentBlocks[idx].text += delta.text;
          fullContent += delta.text;
          sendEvent('content', { content: delta.text });
        } else if (delta.type === 'thinking_delta' && contentBlocks[idx]?.type === 'thinking') {
          contentBlocks[idx].thinking += delta.thinking;
          sendEvent('thinking', { content: delta.thinking });
        }
        break;
      }
      case 'content_block_stop': {
        const idx = parsed.index;
        if (contentBlocks[idx]?.type === 'thinking') {
          sendEvent('thinking_stop', {});
        }
        break;
      }
      case 'error':
        throw new Error(parsed.error?.message || 'Anthropic stream error');
    }
  }

  return { content: fullContent };
}

/* ============================================================
 *  JSONL persistence helpers
 * ============================================================ */

function loadJsonl(filepath) {
  try {
    return fs.readFileSync(filepath, 'utf8').trim().split('\n')
      .filter(Boolean)
      .map(function (l) { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (e) { return []; }
}

function appendJsonl(filepath, obj) {
  fs.appendFileSync(filepath, JSON.stringify(obj) + '\n');
}

/* --- Chat History --- */

function loadHistory() { return loadJsonl(HISTORY_FILE); }
function appendHistory(msg) { appendJsonl(HISTORY_FILE, msg); }

/* ============================================================
 *  ID generation + broadcast
 * ============================================================ */

function nextMsgId(prefix) {
  return prefix + '_' + (++msgIdCounter);
}

var pollQueue = [];
var POLL_MAX = 200;

function broadcast(data, exclude) {
  pollQueue.push({ _t: Date.now(), d: data });
  if (pollQueue.length > POLL_MAX) pollQueue.shift();
  var json = JSON.stringify(data);
  clients.forEach(function (c) {
    if (c !== exclude && c.ws.readyState === WebSocket.OPEN && c.authed) {
      c.ws.send(json);
    }
  });
}

function setBusy(val) {
  ccBusy = val;
  broadcast({ type: 'cc_busy', busy: val });
  if (busyTimer) { clearTimeout(busyTimer); busyTimer = null; }
  if (val) { busyTimer = setTimeout(function () { setBusy(false); }, 120000); }
}

/* ============================================================
 *  Forward user messages to Claude Code via tmux
 * ============================================================ */

function forwardToCC(content, meta) {
  if (!ccAlive) return false;
  var safe = content.replace(/\n/g, ' ');
  var attrKeys = ['chat_id', 'message_id', 'user', 'ts'];
  var attrs = attrKeys
    .filter(function (k) { return meta[k] != null; })
    .map(function (k) { return k + '="' + meta[k] + '"'; })
    .join(' ');
  var text = '<channel source="web" ' + attrs + '>' + safe + '</channel>';
  try {
    var { execFileSync } = require('child_process');
    execFileSync('tmux', ['send-keys', '-t', TMUX_SESSION + ':0', '-l', text], { timeout: 3000 });
    execFileSync('tmux', ['send-keys', '-t', TMUX_SESSION + ':0', 'Enter'], { timeout: 3000 });
    return true;
  } catch (e) {
    log('tmux inject failed: ' + e.message);
    return false;
  }
}

/* ============================================================
 *  Static file serving
 * ============================================================ */

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2',
};

function serveStatic(req, res) {
  var url = req.url.split('?')[0];
  if (url === '/') url = '/index.html';
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

/* ============================================================
 *  Helper: read JSON body from request
 * ============================================================ */

function readBody(req, cb) {
  var body = '';
  req.on('data', function (c) { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', function () {
    try { cb(null, JSON.parse(body)); } catch (e) { cb(e, null); }
  });
}

/* ============================================================
 *  CLIENT HTTP SERVER (serves pages + chat API)
 * ============================================================ */

var clientServer = http.createServer(function (req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  // CORS headers for all responses
  res.setHeader('Access-Control-Allow-Origin', '*');

  // --- Health check ---
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', clients: clients.size, cc_alive: ccAlive }));
    return;
  }

  // --- GET /api/config (配置读取, key 脱敏) ---
  if (req.url === '/api/config' && req.method === 'GET') {
    const cfg = loadConfig();
    const safe = JSON.parse(JSON.stringify(cfg));
    safe.providers = safe.providers.map(function(p) {
      return Object.assign({}, p, { key: p.key ? '***' + p.key.slice(-4) : '' });
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(safe));
    return;
  }

  // --- POST /api/config (配置保存) ---
  if (req.url === '/api/config' && req.method === 'POST') {
    readBody(req, function(err, data) {
      if (err || !data) { res.writeHead(400); res.end('bad json'); return; }
      const current = loadConfig();
      // 保留未修改的 key (前端传回 ***xxxx)
      if (Array.isArray(data.providers)) {
        data.providers = data.providers.map(function(p, i) {
          if (p.key && p.key.startsWith('***') && current.providers[i]) {
            p.key = current.providers[i].key;
          }
          return p;
        });
      }
      saveConfig(Object.assign({}, current, data));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // --- POST /api/chat (API 模式 SSE 流式聊天) ---
  if (req.url === '/api/chat' && req.method === 'POST') {
    readBody(req, async function(err, data) {
      if (err || !data) { res.writeHead(400); res.end('bad json'); return; }

      const config = loadConfig();
      const provider = config.providers.find(function(p) { return p.active; });
      if (!provider || !provider.key) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No active provider configured' }));
        return;
      }

      const messages = data.messages || [];
      const systemPrompt = data.system_prompt !== undefined ? data.system_prompt : (config.system_prompt || '');

      // 判断 provider 类型 — 包含 anthropic 用原生格式, 否则 OpenAI 格式
      const isAnthropic = provider.endpoint.includes('anthropic');

      // SSE 响应头
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });

      function sendEvent(type, obj) {
        try { res.write('data: ' + JSON.stringify(Object.assign({ type: type }, obj)) + '\n\n'); } catch (e) {}
      }

      try {
        if (isAnthropic) {
          await streamAnthropic(provider, systemPrompt, messages, sendEvent);
        } else {
          const allMsgs = [];
          if (systemPrompt) allMsgs.push({ role: 'system', content: systemPrompt });
          allMsgs.push.apply(allMsgs, messages);
          await streamOpenAI(provider, allMsgs, sendEvent);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      } catch (e) {
        log('api/chat error: ' + e.message);
        sendEvent('error', { message: e.message });
        res.write('data: [DONE]\n\n');
        res.end();
      }
    });
    return;
  }

  // --- Long-poll fallback ---
  if (req.url.startsWith('/api/poll')) {
    var since = 0;
    try { since = parseInt(req.url.split('since=')[1]) || 0; } catch (e) {}
    var msgs = pollQueue.filter(function (m) { return m._t > since; }).map(function (m) { return m.d; });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, cc_alive: ccAlive, busy: ccBusy, messages: msgs, t: Date.now() }));
    return;
  }

  // --- POST /api/message  (HTTP chat send fallback) ---
  if (req.url === '/api/message' && req.method === 'POST') {
    readBody(req, function (err, data) {
      if (err || !data) { res.writeHead(400); res.end('bad json'); return; }
      var content = (data.content || '').trim();
      if (!content) { res.writeHead(400); res.end('empty'); return; }
      var msgId = nextMsgId('u');
      var stored = { id: msgId, role: 'user', content: content, ts: new Date().toISOString() };
      appendHistory(stored);
      broadcast({ type: 'message', role: 'user', id: msgId, content: content, ts: stored.ts }, null);
      var fwdMeta = { chat_id: 'poll', message_id: msgId, user: USER_NAME, ts: stored.ts };
      var ok = forwardToCC(content, fwdMeta);
      if (ok) setBusy(true);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: !!ok, id: msgId }));
    });
    return;
  }

  // --- GET /api/recent  (chat history) ---
  if (req.url === '/api/recent') {
    var history = loadHistory().slice(-30);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(history));
    return;
  }

  // --- Static files ---
  if (serveStatic(req, res)) return;

  res.writeHead(404);
  res.end('not found');
});

/* ============================================================
 *  CLIENT WEBSOCKET SERVER
 * ============================================================ */

var clientWss = new WebSocketServer({ server: clientServer, maxPayload: 2 * 1024 * 1024 });

clientWss.on('connection', function (ws, req) {
  var id = 'c_' + (++clientIdCounter);
  var needsAuth = !!AUTH_TOKEN;
  var client = { ws: ws, id: id, authed: !needsAuth };
  clients.set(id, client);
  var cip = req.headers['x-real-ip'] || req.socket.remoteAddress;
  log('client connected: ' + id + ' ip=' + cip);

  if (!needsAuth) {
    ws.send(JSON.stringify({ type: 'auth_ok', client_id: id, cc_alive: ccAlive }));
  }

  ws.on('message', function (raw) {
    var msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    if (msg.type === 'pong') return;

    // Auth flow (only if AUTH_TOKEN is set)
    if (!client.authed) {
      if (msg.type === 'auth' && msg.token === AUTH_TOKEN) {
        client.authed = true;
        ws.send(JSON.stringify({ type: 'auth_ok', client_id: id, cc_alive: ccAlive }));
      } else {
        ws.send(JSON.stringify({ type: 'auth_fail', message: 'invalid token' }));
      }
      return;
    }

    // Chat message
    if (msg.type === 'message') {
      var content = (msg.content || '').trim();
      if (!content) return;
      var msgId = nextMsgId('u');
      var stored = { id: msgId, role: 'user', content: content, ts: new Date().toISOString() };
      appendHistory(stored);
      broadcast({ type: 'message', role: 'user', id: msgId, content: content, ts: stored.ts }, null);
      var fwdMeta = { chat_id: id, message_id: msgId, user: USER_NAME, ts: stored.ts };
      var ok = forwardToCC(content, fwdMeta);
      if (ok) { setBusy(true); } else { ws.send(JSON.stringify({ type: 'error', message: 'CC is offline' })); }
    }
  });

  ws.on('close', function () {
    clients.delete(id);
    log('client disconnected: ' + id);
  });

  // Heartbeat
  var hb = setInterval(function () {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'ping', t: Date.now() })); } catch (e) {}
    }
  }, 25000);
  ws.on('close', function () { clearInterval(hb); });
});

clientServer.listen(CLIENT_PORT, '127.0.0.1', function () {
  log('client server on 127.0.0.1:' + CLIENT_PORT);
});

/* ============================================================
 *  BRIDGE WEBSOCKET SERVER (internal, for MCP bridge.js)
 * ============================================================ */

var bridgeServer = http.createServer();
var bridgeWss = new WebSocketServer({ server: bridgeServer });

bridgeWss.on('connection', function (ws) {
  if (bridge && bridge.readyState === WebSocket.OPEN) {
    bridge.close(1000, 'replaced');
  }
  bridge = ws;
  bridgeReady = true;
  ccAlive = true;
  broadcast({ type: 'cc_status', alive: true });
  log('bridge connected');

  ws.on('message', function (raw) {
    var msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    if (msg.type === 'reply') {
      var text = msg.text || '';
      var msgId = nextMsgId('s');
      var stored = { id: msgId, role: 'assistant', content: text, ts: new Date().toISOString() };
      if (msg.reply_to) stored.reply_to = msg.reply_to;
      appendHistory(stored);
      broadcast({ type: 'message', role: 'assistant', id: msgId, content: text, ts: stored.ts });
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

  ws.on('close', function () {
    bridgeReady = false;
    ccAlive = false;
    bridge = null;
    broadcast({ type: 'cc_status', alive: false });
    log('bridge disconnected');
  });
});

bridgeServer.listen(BRIDGE_PORT, '127.0.0.1', function () {
  log('bridge server on 127.0.0.1:' + BRIDGE_PORT);
});

/* ============================================================
 *  Graceful shutdown
 * ============================================================ */

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function shutdown() {
  log('shutting down...');
  clients.forEach(function (c) { c.ws.close(); });
  if (bridge) bridge.close();
  clientServer.close();
  bridgeServer.close();
  setTimeout(function () { process.exit(0); }, 1000);
}
