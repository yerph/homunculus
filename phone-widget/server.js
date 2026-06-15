/**
 * Phone Widget Hub Server
 *
 * Two-port architecture:
 *   CLIENT_PORT  (3462) — serves static files + HTTP API + WebSocket for browser clients
 *   BRIDGE_PORT  (3463) — internal WebSocket for MCP bridge (Claude Code sends replies here)
 *
 * No Express dependency — raw Node.js http + ws.
 */

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const fs = require('fs');
const path = require('path');

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

const CLIENT_PORT  = parseInt(process.env.CLIENT_PORT)  || 3462;
const BRIDGE_PORT  = parseInt(process.env.BRIDGE_PORT)   || 3463;

/* CUSTOMIZE: set an auth token to protect your WebSocket. Leave empty to disable auth. */
const AUTH_TOKEN   = process.env.AUTH_TOKEN || '';

/* CUSTOMIZE: tmux session name where Claude Code is running (used by forwardToCC) */
const TMUX_SESSION = process.env.TMUX_SESSION || 'cc';

/* CUSTOMIZE: name used in the channel tag forwarded to Claude Code */
const USER_NAME    = process.env.USER_NAME || 'user';

const HISTORY_FILE = path.join(__dirname, 'data', 'history.jsonl');
const TWEETS_FILE  = path.join(__dirname, 'data', 'tweets.jsonl');
const MAILS_FILE   = path.join(__dirname, 'data', 'mails.jsonl');
const PUBLIC_DIR   = path.join(__dirname, 'public');

// Ensure data directory exists
try { fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true }); } catch (e) {}

/* ============================================================
 *  State
 * ============================================================ */

let clientIdCounter = 0;
let msgIdCounter    = 0;
let tweetIdCounter  = 0;
let mailIdCounter   = 0;
const clients       = new Map();
let bridge          = null;
let bridgeReady     = false;
let ccAlive         = false;
let ccBusy          = false;
let busyTimer       = null;

function log(msg) { console.log('[hub] ' + msg); }

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

function saveJsonl(filepath, arr) {
  fs.writeFileSync(filepath, arr.map(function (o) { return JSON.stringify(o); }).join('\n') + '\n');
}

/* --- History --- */

function loadHistory() { return loadJsonl(HISTORY_FILE); }
function appendHistory(msg) { appendJsonl(HISTORY_FILE, msg); }

/* --- Tweets --- */

function loadTweets() {
  var tweets = loadJsonl(TWEETS_FILE);
  tweets.forEach(function (t) {
    var num = parseInt((t.id || '').replace('tw_', ''));
    if (num > tweetIdCounter) tweetIdCounter = num;
  });
  return tweets;
}

function saveTweets(tweets) { saveJsonl(TWEETS_FILE, tweets); }
function appendTweet(tweet)  { appendJsonl(TWEETS_FILE, tweet); }

/* --- Mails --- */

function loadMails() {
  var mails = loadJsonl(MAILS_FILE);
  mails.forEach(function (m) {
    var num = parseInt((m.id || '').replace('mail_', ''));
    if (num > mailIdCounter) mailIdCounter = num;
  });
  return mails;
}

function appendMail(mail) { appendJsonl(MAILS_FILE, mail); }

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
 *  CLIENT HTTP SERVER (serves pages + API)
 * ============================================================ */

var clientServer = http.createServer(function (req, res) {
  // --- Health check ---
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', clients: clients.size, cc_alive: ccAlive }));
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

  // --- POST /api/message  (long-poll chat send) ---
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

  // --- GET /api/recent ---
  if (req.url === '/api/recent') {
    var history = loadHistory().slice(-30);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(history));
    return;
  }

  // --- Tweet API ---

  // GET /api/tweets
  if (req.url === '/api/tweets' && req.method === 'GET') {
    var tweets = loadTweets();
    tweets.reverse();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(tweets));
    return;
  }

  // POST /api/tweets  (create new tweet)
  if (req.url === '/api/tweets' && req.method === 'POST') {
    readBody(req, function (err, data) {
      if (err || !data) { res.writeHead(400); res.end('bad json'); return; }
      /* CUSTOMIZE: valid author names for tweets */
      var author = data.author || 'companion';
      var text = (data.text || '').trim();
      if (!text) { res.writeHead(400); res.end('empty text'); return; }
      var tweet = {
        id: 'tw_' + (++tweetIdCounter),
        author: author,
        text: text,
        ts: new Date().toISOString(),
        likes: [],
        comments: [],
      };
      appendTweet(tweet);
      broadcast({ type: 'tweet_new', tweet: tweet });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(tweet));
    });
    return;
  }

  // POST /api/tweets/:id/like
  var likeMatch = req.url.match(/^\/api\/tweets\/(tw_\d+)\/like$/);
  if (likeMatch && req.method === 'POST') {
    readBody(req, function (err, data) {
      if (err || !data) { res.writeHead(400); res.end('bad json'); return; }
      var user = data.user || 'user';
      var tweets = loadTweets();
      var tw = tweets.find(function (t) { return t.id === likeMatch[1]; });
      if (!tw) { res.writeHead(404); res.end('not found'); return; }
      if (!tw.likes) tw.likes = [];
      var idx = tw.likes.indexOf(user);
      if (idx >= 0) { tw.likes.splice(idx, 1); } else { tw.likes.push(user); }
      saveTweets(tweets);
      broadcast({ type: 'tweet_like', id: tw.id, likes: tw.likes });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ liked: idx < 0, likes: tw.likes }));
    });
    return;
  }

  // POST /api/tweets/:id/comment
  var cmtMatch = req.url.match(/^\/api\/tweets\/(tw_\d+)\/comment$/);
  if (cmtMatch && req.method === 'POST') {
    readBody(req, function (err, data) {
      if (err || !data) { res.writeHead(400); res.end('bad json'); return; }
      var author = data.author || 'user';
      var text = (data.text || '').trim();
      if (!text) { res.writeHead(400); res.end('empty text'); return; }
      var tweets = loadTweets();
      var tw = tweets.find(function (t) { return t.id === cmtMatch[1]; });
      if (!tw) { res.writeHead(404); res.end('not found'); return; }
      if (!tw.comments) tw.comments = [];
      var cmt = { id: 'cm_' + Date.now(), author: author, text: text, ts: new Date().toISOString() };
      if (data.reply_to) { cmt.reply_to = data.reply_to; cmt.reply_to_author = data.reply_to_author || ''; }
      tw.comments.push(cmt);
      saveTweets(tweets);
      broadcast({ type: 'tweet_comment', tweet_id: tw.id, comment: cmt, total: tw.comments.length });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cmt));
    });
    return;
  }

  // DELETE /api/tweets/:id
  var delMatch = req.url.match(/^\/api\/tweets\/(tw_\d+)$/);
  if (delMatch && req.method === 'DELETE') {
    var tweets = loadTweets();
    var idx = tweets.findIndex(function (t) { return t.id === delMatch[1]; });
    if (idx < 0) { res.writeHead(404); res.end('not found'); return; }
    tweets.splice(idx, 1);
    saveTweets(tweets);
    broadcast({ type: 'tweet_delete', id: delMatch[1] });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true }));
    return;
  }

  // --- Mail API ---

  // GET /api/mails
  if (req.url === '/api/mails' && req.method === 'GET') {
    var mails = loadMails();
    mails.reverse();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(mails));
    return;
  }

  // POST /api/mails  (send a new postcard)
  if (req.url === '/api/mails' && req.method === 'POST') {
    readBody(req, function (err, data) {
      if (err || !data) { res.writeHead(400); res.end('bad json'); return; }
      var from = (data.from || '').trim();
      var subj = (data.subj || '').trim();
      var mailBody = (data.body || '').trim();
      if (!from || !subj || !mailBody) { res.writeHead(400); res.end('missing fields'); return; }
      var mail = {
        id: 'mail_' + (++mailIdCounter),
        from: from,
        av: data.av || from.charAt(0),
        col: data.col || 'var(--accent)',
        subj: subj,
        body: mailBody,
        ts: new Date().toISOString(),
        unread: true,
      };
      appendMail(mail);
      broadcast({ type: 'mail_new', mail: mail });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mail));
    });
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
