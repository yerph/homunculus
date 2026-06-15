/**
 * CC Companion Chat Server
 *
 * A lightweight Express server that provides:
 *  - Static file serving for the chat UI
 *  - Password-protected API endpoints
 *  - Message history stored in a JSON file
 *  - Sticker/emoji management
 *  - A bridge to Claude Code via the MCP web-channel plugin
 *
 * Messages sent from the web UI are delivered to Claude Code as
 * <channel source="web" ...> events through the MCP web-channel tool.
 * Claude Code replies arrive back through the same bridge and are
 * forwarded to the browser via polling.
 *
 * Environment variables:
 *   CHAT_PASSWORD  - password for the web UI (required)
 *   CHAT_PORT      - server port (default 3500)
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// .env loader (no extra dependency)
// ---------------------------------------------------------------------------
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
    const eq = line.indexOf('=');
    if (eq > 0) {
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      if (key && !process.env[key]) process.env[key] = val;
    }
  });
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.CHAT_PORT) || 3500;
const PASSWORD = process.env.CHAT_PASSWORD || '';
const DATA_DIR = path.join(__dirname, 'data');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const STICKERS_FILE = path.join(DATA_DIR, 'stickers.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Helpers — message store (simple JSON file)
// ---------------------------------------------------------------------------
function loadMessages() {
  try { return JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8')); }
  catch { return []; }
}

function saveMessages(msgs) {
  fs.writeFileSync(MESSAGES_FILE, JSON.stringify(msgs, null, 2));
}

function loadStickers() {
  try { return JSON.parse(fs.readFileSync(STICKERS_FILE, 'utf8')); }
  catch { return []; }
}

function saveStickers(s) {
  fs.writeFileSync(STICKERS_FILE, JSON.stringify(s, null, 2));
}

// ---------------------------------------------------------------------------
// CC Bridge state
// ---------------------------------------------------------------------------
// Messages waiting to be picked up by the browser (assistant replies)
let pendingForBrowser = [];
// Messages waiting to be picked up by Claude Code (user messages)
let pendingForCC = [];
// Track whether CC has polled recently
let lastCCPoll = 0;

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

// --- Rate limiting ---
const rateMap = new Map();
function rateLimit(req, res, next) {
  const ip = req.headers['x-real-ip'] || req.ip;
  const now = Date.now();
  const window = 60_000;
  const max = 60;
  const hits = rateMap.get(ip) || [];
  const recent = hits.filter(t => t > now - window);
  if (recent.length >= max) return res.status(429).json({ error: 'Too many requests' });
  recent.push(now);
  rateMap.set(ip, recent);
  next();
}
app.use('/api/', rateLimit);

// --- Security headers ---
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, fp) => {
    if (fp.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store');
  }
}));

// --- Auth middleware ---
function auth(req, res, next) {
  if (!PASSWORD) return next(); // no password configured = open access
  const token = req.headers['x-auth-token'] || req.query.token;
  if (token === PASSWORD) return next();
  res.status(401).json({ error: 'unauthorized' });
}

// ---------------------------------------------------------------------------
// API: Messages
// ---------------------------------------------------------------------------

/**
 * GET /api/messages?since=<timestamp>
 * Returns messages, optionally filtered to those after `since`.
 */
app.get('/api/messages', auth, (req, res) => {
  const msgs = loadMessages();
  const since = parseInt(req.query.since) || 0;
  const filtered = since ? msgs.filter(m => m.ts > since) : msgs;
  res.json(filtered);
});

/**
 * POST /api/message
 * Body: { content: string, type?: "text"|"sticker"|"image" }
 *
 * Saves the user message and queues it for Claude Code pickup.
 */
app.post('/api/message', auth, (req, res) => {
  const { content, type } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });

  const msg = {
    id: 'm_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex'),
    role: 'user',
    content,
    type: type || 'text',
    ts: Date.now()
  };

  const msgs = loadMessages();
  msgs.push(msg);
  saveMessages(msgs);

  // Queue for CC pickup
  pendingForCC.push(msg);

  res.json({ ok: true, message: msg });
});

/**
 * POST /api/message/assistant
 * Body: { content: string }
 *
 * Called by the CC bridge (or manually) to inject an assistant message.
 */
app.post('/api/message/assistant', auth, (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });

  const msg = {
    id: 'm_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex'),
    role: 'assistant',
    content,
    type: 'text',
    ts: Date.now()
  };

  const msgs = loadMessages();
  msgs.push(msg);
  saveMessages(msgs);

  // Queue for browser pickup
  pendingForBrowser.push(msg);

  res.json({ ok: true, message: msg });
});

/**
 * POST /api/react
 * Body: { messageId: string, emoji: string }
 *
 * Adds an emoji reaction to a message.
 */
app.post('/api/react', auth, (req, res) => {
  const { messageId, emoji } = req.body;
  if (!messageId || !emoji) return res.status(400).json({ error: 'messageId and emoji required' });

  const msgs = loadMessages();
  const msg = msgs.find(m => m.id === messageId);
  if (!msg) return res.status(404).json({ error: 'message not found' });

  if (!msg.reactions) msg.reactions = {};
  msg.reactions[emoji] = (msg.reactions[emoji] || 0) + 1;
  saveMessages(msgs);

  res.json({ ok: true, reactions: msg.reactions });
});

/**
 * DELETE /api/messages
 * Clears all message history.
 */
app.delete('/api/messages', auth, (req, res) => {
  saveMessages([]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// API: Stickers
// ---------------------------------------------------------------------------

app.get('/api/stickers', auth, (req, res) => {
  res.json(loadStickers());
});

app.post('/api/stickers', auth, (req, res) => {
  const { url, name, desc } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  const stickers = loadStickers();
  const id = 's_' + Date.now().toString(36);
  stickers.push({ id, url, name: name || '', desc: desc || '', ts: Date.now() });
  saveStickers(stickers);
  res.json({ ok: true, id });
});

app.delete('/api/stickers/:id', auth, (req, res) => {
  let stickers = loadStickers();
  stickers = stickers.filter(s => s.id !== req.params.id);
  saveStickers(stickers);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// CC Bridge — polling endpoints
// ---------------------------------------------------------------------------

/**
 * GET /cc-poll?since=<timestamp>
 *
 * Browser polls this to receive assistant messages and CC status.
 */
app.get('/cc-poll', auth, (req, res) => {
  const msgs = pendingForBrowser.splice(0);
  const ccAlive = (Date.now() - lastCCPoll) < 30_000;
  res.json({
    ok: true,
    cc_alive: ccAlive,
    messages: msgs.map(m => ({ type: 'message', role: m.role, content: m.content, ts: m.ts })),
    t: Date.now()
  });
});

/**
 * POST /cc-msg
 * Body: { content: string }
 *
 * Browser sends user messages here; they queue for CC pickup.
 */
app.post('/cc-msg', auth, (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });

  pendingForCC.push({
    role: 'user',
    content,
    ts: Date.now()
  });

  res.json({ ok: true });
});

/**
 * GET /cc-bridge/pending
 *
 * Claude Code (via MCP web-channel) polls this to pick up user messages.
 * Each call drains the pending queue.
 */
app.get('/cc-bridge/pending', (req, res) => {
  lastCCPoll = Date.now();
  const msgs = pendingForCC.splice(0);
  res.json({ messages: msgs });
});

/**
 * POST /cc-bridge/reply
 * Body: { content: string }
 *
 * Claude Code posts replies here; they get saved and forwarded to browser.
 */
app.post('/cc-bridge/reply', (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });

  const msg = {
    id: 'm_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex'),
    role: 'assistant',
    content,
    type: 'text',
    ts: Date.now()
  };

  const msgs = loadMessages();
  msgs.push(msg);
  saveMessages(msgs);

  pendingForBrowser.push(msg);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// API: Health
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    ts: new Date().toISOString(),
    cc_alive: (Date.now() - lastCCPoll) < 30_000,
    messages: loadMessages().length
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, '127.0.0.1', () => {
  console.log(`cc-companion chat-server on 127.0.0.1:${PORT}`);
  if (!PASSWORD) {
    console.log('[WARN] CHAT_PASSWORD not set — API is open to anyone on localhost');
  }
});
