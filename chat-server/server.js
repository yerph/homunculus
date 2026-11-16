/**
 * CC Companion Chat Server
 *
 * 功能概览:
 *  - 多 provider 支持 (Anthropic / OpenAI 格式自动识别)
 *  - SSE 流式聊天 (thinking, content, tool, usage 事件)
 *  - 会话管理 (文件系统 JSON 存储)
 *  - 文件夹 / 贴纸管理
 *  - CC Bridge (Claude Code 双模式桥接)
 *  - 配置热加载 (config.json + system-prompt.md)
 *
 * 环境变量:
 *   CHAT_PASSWORD  - Web UI 认证密码 (必填)
 *   CHAT_PORT      - 服务端口 (默认 4500)
 */

const express = require('express');
const fs = require('fs');
const fetch = require('node-fetch');
const path = require('path');
const crypto = require('crypto');
const { forwardAPIContext } = require('./lib/api-sync');

// ============================================================
// .env 加载器 (无额外依赖)
// ============================================================
const _envPath = [path.join(__dirname, '.env'), path.join(__dirname, '..', '.env')]
  .find(file => fs.existsSync(file));
if (_envPath) {
  fs.readFileSync(_envPath, 'utf-8').split('\n').forEach(line => {
    if (!line.trim() || /^\s*#/.test(line)) return;
    const eq = line.indexOf('=');
    if (eq <= 0) return;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return;
    let val = line.slice(eq+1).trim();
    if (!val.startsWith('\"') && !val.startsWith("'")) val = val.replace(/\s+#.*$/, '').trim();
    if ((val.startsWith('\"') && val.endsWith('\"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1,-1);
    if (!Object.hasOwn(process.env,key)) process.env[key] = val;
  });
}

// ============================================================
// 基础配置 & 目录初始化
// ============================================================
const PORT = parseInt(process.env.CHAT_PORT) || 4500;
const PASSWORD = process.env.CHAT_PASSWORD || '';

const DATA_DIR = path.join(__dirname, 'data');
const CONV_DIR = path.join(DATA_DIR, 'conversations');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const PROMPT_PATH = path.join(DATA_DIR, 'system-prompt.md');
const FOLDERS_FILE = path.join(DATA_DIR, 'folders.json');
const STICKER_FILE = path.join(DATA_DIR, 'stickers.json');
const LOG_FILE = path.join(DATA_DIR, 'chat-log.jsonl');

// 确保目录存在
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(CONV_DIR)) fs.mkdirSync(CONV_DIR, { recursive: true });

// 默认配置 (首次启动时创建)
const DEFAULT_CONFIG = {
  providers: [
    { name: 'Anthropic', endpoint: 'https://api.anthropic.com/v1/messages', key: '', model: 'claude-sonnet-4-20250514', active: true },
    { name: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1/chat/completions', key: '', model: '', active: false }
  ],
  context_max_messages: 50,
  system_prompt: ''
};

if (!fs.existsSync(CONFIG_PATH)) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
  console.log('[init] 已创建默认 config.json');
}
if (!fs.existsSync(PROMPT_PATH)) {
  fs.writeFileSync(PROMPT_PATH, '');
  console.log('[init] 已创建空 system-prompt.md');
}

// ============================================================
// 配置读取
// ============================================================
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) { console.error('[config] 读取失败:', e.message); return DEFAULT_CONFIG; }
}

function loadSystemPrompt() {
  try { return fs.readFileSync(PROMPT_PATH, 'utf8'); }
  catch (e) { return ''; }
}

// ============================================================
// 工具函数 — endpoint / model 判断
// ============================================================
function normalizeEndpoint(url) {
  url = url.replace(/\/+$/, '');
  if (!url.endsWith('/chat/completions') && !url.endsWith('/messages')) {
    url += '/chat/completions';
  }
  return url;
}

function isClaudeModel(model) {
  return typeof model === 'string' && model.toLowerCase().includes('claude');
}

// Keep user-configured providers generic: model name alone does not imply that a
// third-party OpenAI-compatible endpoint accepts reasoning-specific fields.
function providerUsesAnthropicAPI(provider) {
  return provider.api_format === 'anthropic' ||
    (provider.api_format !== 'openai' && /\/messages\/?$/.test(provider.endpoint || ''));
}
function safeUpstreamError(response) {
  // Never forward raw upstream errors: gateways can echo tokens or URLs.
  return `Upstream provider returned HTTP ${response.status}`;
}
function createRequestSignal(parentSignal) {
  const controller = new AbortController();
  const timeoutMs = Number(process.env.API_REQUEST_TIMEOUT_MS) || 120000;
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return { signal: controller.signal, cleanup: () => clearTimeout(timer) };
}

function toAnthropicEndpoint(endpoint) {
  let url = endpoint.replace(/\/+$/, '');
  url = url.replace(/\/chat\/completions$/, '');
  if (!url.endsWith('/v1/messages')) {
    url = url.replace(/\/v1$/, '') + '/v1/messages';
  }
  return url;
}

/** Anthropic 不支持 file 类型 block, 转为 text */
function sanitizeForAnthropic(messages) {
  return messages.map(m => {
    if (!Array.isArray(m.content)) return m;
    const cleaned = m.content.map(block => {
      if (block.type === 'file') {
        return { type: 'text', text: '[文件: ' + (block.name || 'unknown') + ']\n' + (block.data || '') };
      }
      return block;
    });
    return { ...m, content: cleaned };
  });
}

/** Anthropic image block → OpenAI image_url 格式 */
function convertToOpenAI(msgs) {
  return msgs.map(m => {
    if (!Array.isArray(m.content)) return m;
    const parts = m.content.map(p => {
      if (p.type === 'image' && p.source) {
        return { type: 'image_url', image_url: { url: 'data:' + p.source.media_type + ';base64,' + p.source.data } };
      }
      if (p.type === 'text') return { type: 'text', text: p.text };
      return p;
    });
    return { ...m, content: parts };
  });
}

// ============================================================
// SSE 流读取器
// ============================================================
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

// ============================================================
// Express 应用初始化
// ============================================================
const app = express();

// --- 速率限制 ---
const rateMap = new Map();
function rateLimit(req, res, next) {
  const ip = req.headers['x-real-ip'] || req.ip;
  const now = Date.now();
  const window = 60000;
  const max = 60;
  const hits = rateMap.get(ip) || [];
  const recent = hits.filter(t => t > now - window);
  if (recent.length >= max) return res.status(429).json({ error: 'Too many requests' });
  recent.push(now);
  rateMap.set(ip, recent);
  next();
}
app.use('/api/', rateLimit);

// --- CORS (开发环境, 允许 localhost) ---
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-auth-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// --- 安全头 ---
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, fp) => {
    if (fp.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store');
  }
}));

// --- 认证中间件 ---
function auth(req, res, next) {
  if (!PASSWORD) return res.status(503).json({ error: 'CHAT_PASSWORD is not configured' });
  const t = req.headers['x-auth-token'];
  if (typeof t !== 'string') return res.status(401).json({ error: 'unauthorized' });
  const x = Buffer.from(t), y = Buffer.from(PASSWORD);
  if (x.length === y.length && crypto.timingSafeEqual(x,y)) return next();
  res.status(401).json({ error: 'unauthorized' });
}

// ============================================================
// 配置管理 API
// ============================================================
app.get('/api/config', auth, (req, res) => {
  const c = loadConfig();
  // 隐藏 API key, 只返回末四位
  c.providers = c.providers.map(p => ({ ...p, key: p.key ? '***' + p.key.slice(-4) : '' }));
  c.system_prompt = loadSystemPrompt() || c.system_prompt || '';
  res.json(c);
});

app.post('/api/config', auth, (req, res) => {
  const current = loadConfig();
  const update = req.body;
  // Keep masked keys matched by provider name, not array position.
  if (Array.isArray(update.providers)) {
    const existing = new Map((current.providers || []).map(p => [p.name, p.key]));
    update.providers = update.providers.map(p => ({
      ...p,
      key: (!p.key || p.key.startsWith('***')) ? (existing.get(p.name) || '') : p.key
    }));
  }
  // system prompt 单独存文件
  if (update.system_prompt !== undefined) {
    fs.writeFileSync(PROMPT_PATH, update.system_prompt);
    delete update.system_prompt;
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...current, ...update }, null, 2));
  res.json({ ok: true });
});

// ============================================================
// OpenAI 格式流式请求
// ============================================================
async function streamOpenAI(provider, allMsgs, sendEvent, enableThinking = false, signal) {
  const chatUrl = normalizeEndpoint(provider.endpoint);
  const reqBody = {
    model: provider.model,
    messages: allMsgs,
    stream: true,
    stream_options: { include_usage: true }
  };

  // Reasoning is opt-in. Do not send unsupported fields to arbitrary gateways.
  if (enableThinking && provider.reasoning_format === 'openrouter') {
    reqBody.reasoning = { max_tokens: 10000 };
  } else if (enableThinking && provider.reasoning_format === 'anthropic-compat') {
    reqBody.thinking = { type: 'enabled', budget_tokens: 10000 };
  }

  const r = await fetch(chatUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + provider.key
    },
    body: JSON.stringify(reqBody),
    signal
  });

  if (!r.ok) throw new Error(safeUpstreamError(r));

  let fullContent = '';
  let reasoningContent = '';
  let usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

  for await (const line of readSSELines(r.body)) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]') break;

    let parsed;
    try { parsed = JSON.parse(data); } catch (e) { continue; }

    if (parsed.usage) {
      usage.input_tokens = parsed.usage.prompt_tokens || 0;
      usage.output_tokens = parsed.usage.completion_tokens || 0;
    }

    const delta = parsed.choices?.[0]?.delta;
    if (!delta) continue;

    // thinking / reasoning 内容
    if (delta.reasoning_content || delta.reasoning) {
      const rc = delta.reasoning_content || delta.reasoning;
      reasoningContent += rc;
      sendEvent('thinking', { content: rc });
    }

    // 正文内容
    if (delta.content) {
      fullContent += delta.content;
      sendEvent('content', { content: delta.content });
    }
  }

  console.log('[openai] usage:', JSON.stringify(usage));
  sendEvent('usage', { usage });

  return { content: fullContent, reasoning: reasoningContent };
}

// ============================================================
// Anthropic 原生流式请求
// ============================================================
async function streamAnthropic(provider, systemPrompt, convMessages, sendEvent, enableThinking, signal) {
  const reqBody = {
    model: provider.model,
    max_tokens: 4096,
    system: systemPrompt,
    messages: convMessages,
    stream: true
  };
  if (enableThinking) {
    reqBody.thinking = { type: 'enabled', budget_tokens: 10000 };
    reqBody.max_tokens = 16000;
  }

  const endpoint = toAnthropicEndpoint(provider.endpoint);
  const isNative = provider.endpoint.includes('anthropic.com');
  console.log('[anthropic] endpoint:', endpoint, '| model:', reqBody.model, '| thinking:', !!reqBody.thinking, '| msgs:', reqBody.messages?.length);

  const r = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(isNative
        ? { 'x-api-key': provider.key }
        : { 'Authorization': 'Bearer ' + provider.key }),
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(reqBody),
    signal
  });

  if (!r.ok) throw new Error(safeUpstreamError(r));

  // 累积内容块
  const contentBlocks = [];
  let currentBlockIdx = -1;
  let currentInputJson = '';
  let usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

  for await (const line of readSSELines(r.body)) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();

    let parsed;
    try { parsed = JSON.parse(data); } catch (e) { continue; }

    switch (parsed.type) {
      case 'message_start': {
        if (parsed.message?.usage) {
          const u = parsed.message.usage;
          usage.input_tokens = u.input_tokens || 0;
          usage.cache_read_input_tokens = u.cache_read_input_tokens || 0;
          usage.cache_creation_input_tokens = u.cache_creation_input_tokens || 0;
          usage.output_tokens = u.output_tokens || 0;
        }
        break;
      }
      case 'content_block_start': {
        currentBlockIdx = parsed.index;
        const block = parsed.content_block;
        if (block.type === 'thinking') {
          contentBlocks[currentBlockIdx] = { type: 'thinking', thinking: '', signature: '' };
          sendEvent('thinking_start', {});
        } else if (block.type === 'text') {
          contentBlocks[currentBlockIdx] = { type: 'text', text: '' };
        } else if (block.type === 'tool_use') {
          contentBlocks[currentBlockIdx] = { type: 'tool_use', id: block.id, name: block.name, input: {} };
          currentInputJson = '';
        }
        break;
      }
      case 'content_block_delta': {
        const idx = parsed.index;
        const delta = parsed.delta;
        if (delta.type === 'thinking_delta' && contentBlocks[idx]?.type === 'thinking') {
          contentBlocks[idx].thinking += delta.thinking;
          sendEvent('thinking', { content: delta.thinking });
        } else if (delta.type === 'text_delta' && contentBlocks[idx]) {
          contentBlocks[idx].text += delta.text;
          sendEvent('content', { content: delta.text });
        } else if (delta.type === 'signature_delta' && contentBlocks[idx]?.type === 'thinking') {
          contentBlocks[idx].signature = (contentBlocks[idx].signature || '') + delta.signature;
        } else if (delta.type === 'input_json_delta') {
          currentInputJson += delta.partial_json;
        }
        break;
      }
      case 'content_block_stop': {
        const idx = parsed.index;
        if (contentBlocks[idx]?.type === 'thinking') {
          sendEvent('thinking_stop', {});
        }
        if (contentBlocks[idx]?.type === 'tool_use' && currentInputJson) {
          try { contentBlocks[idx].input = JSON.parse(currentInputJson); }
          catch (e) { contentBlocks[idx].input = {}; }
          currentInputJson = '';
        }
        break;
      }
      case 'message_delta': {
        if (parsed.usage) {
          usage.output_tokens = parsed.usage.output_tokens || usage.output_tokens;
          if (parsed.usage.cache_read_input_tokens) usage.cache_read_input_tokens = parsed.usage.cache_read_input_tokens;
          if (parsed.usage.cache_creation_input_tokens) usage.cache_creation_input_tokens = parsed.usage.cache_creation_input_tokens;
        }
        break;
      }
      case 'error':
        throw new Error(parsed.error?.message || 'Anthropic stream error');
    }
  }

  console.log('[anthropic] usage:', JSON.stringify(usage));
  sendEvent('usage', { usage });

  const fullText = contentBlocks.filter(b => b?.type === 'text').map(b => b.text || '').join('');
  const toolUses = contentBlocks.filter(b => b?.type === 'tool_use');
  return { content: fullText, contentBlocks: contentBlocks.filter(Boolean), toolUses };
}

// ============================================================
// 主聊天端点 — POST /api/chat (SSE 流式)
// ============================================================
app.post('/api/chat', auth, async (req, res) => {
  const config = loadConfig();
  const provider = config.providers.find(p => p.active);
  if (!provider?.key) return res.status(400).json({ error: 'No active provider configured' });

  const { messages, message, conversation_id, cc_sync, system_prompt: reqSystemPrompt, thinking: enableThinking, cc_context } = req.body;
  // The bundled frontend sends `message`; generic API clients may send `messages`.
  let inputMessages = Array.isArray(messages) ? messages : (message !== undefined ? [{ role: 'user', content: message }] : []);
  if (!inputMessages.length) return res.status(400).json({ error: 'messages or message required' });
  const latestUser = [...inputMessages].reverse().find(m => m.role === 'user');
  let streamedText = '';
  let systemPrompt = reqSystemPrompt !== undefined ? reqSystemPrompt : (loadSystemPrompt() || config.system_prompt || '');

  // CC context injection (conversation-scoped, sent by frontend when cc-sync is on)
  if (cc_context) {
    if (cc_context.summary) {
      systemPrompt = systemPrompt + '\n\n' + cc_context.summary;
    }
    if (cc_context.recent && cc_context.recent.length > 0 && inputMessages.length > 0) {
      inputMessages = [...inputMessages];
      inputMessages.splice(inputMessages.length - 1, 0, ...cc_context.recent);
    }
  }

  // Explicit api_format wins over inference; /messages is the safe fallback.
  const isAnthropic = providerUsesAnthropicAPI(provider);
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  req.on('aborted', () => controller.abort());
  const request = createRequestSignal(controller.signal);

  // SSE 响应头
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (type, data) => {
    if (type === 'content' && typeof data.content === 'string') streamedText += data.content;
    try { res.write('data: ' + JSON.stringify({ type, ...data }) + '\n\n'); } catch (e) {}
  };

  try {
    if (isAnthropic) {
      // --- Anthropic 原生格式 ---
      const sanitized = sanitizeForAnthropic(inputMessages);
      const { content, toolUses } = await streamAnthropic(
        provider, systemPrompt, sanitized, sendEvent, enableThinking, request.signal
      );

      // 工具调用只透传事件, 不执行
      for (const tu of toolUses) {
        sendEvent('tool', { name: tu.name, args: tu.input });
      }
    } else {
      // --- OpenAI 兼容格式 ---
      const allMsgs = [];
      if (systemPrompt) allMsgs.push({ role: 'system', content: systemPrompt });
      allMsgs.push(...convertToOpenAI(inputMessages));

      await streamOpenAI(provider, allMsgs, sendEvent, enableThinking, request.signal);
    }

    // Same API -> Hub inbox path as the running original: append a scoped log
    // entry, push it to the inbox, and let Hub query the log if push fails.
    if (conversation_id && streamedText.trim() && latestUser) {
      const entry = { ts: new Date().toISOString(),
        user: typeof latestUser.content === 'string' ? latestUser.content : JSON.stringify(latestUser.content),
        assistant: streamedText, model: provider.model || '', via: 'api', conversation_id };
      fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', { mode: 0o600 });
      if (cc_sync === true) forwardAPIContext(entry, process.env.BRIDGE_AUTH_TOKEN, true).catch(() => {});
    }
    res.write('data: [DONE]\n\n');
    res.end();

  } catch (e) {
    const message = request.signal.aborted ? 'Request cancelled or timed out' : e.message;
    console.error('[chat] error:', message);
    if (!res.destroyed) {
      sendEvent('error', { message });
      res.write('data: [DONE]\n\n');
      res.end();
    }
  } finally {
    request.cleanup();
  }
});

// ============================================================
// Context compression — uses a secondary cheap model to summarize old messages
// ============================================================
app.post('/api/compress', auth, async (req, res) => {
  const config = loadConfig();
  const { messages, existing_summary } = req.body;
  if (!messages?.length) return res.status(400).json({ error: 'messages required' });

  // DeepSeek or another inexpensive OpenAI-compatible provider is preferred,
  // but no third-party API key is shipped or hard-coded.
  const available = (config.providers || []).filter(p => p.key && p.model && p.endpoint);
  const compressProvider = available.find(p => p.compression === true)
    || available.find(p => /deepseek/i.test(p.name || ''))
    || available.find(p => !providerUsesAnthropicAPI(p))
    || available[0];
  if (!compressProvider) return res.status(400).json({ error: 'Configure a compression provider in Settings.' });

  const convText = messages.map(m => {
    const role = m.role === 'user' ? 'User' : 'Assistant';
    const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    return role + ': ' + c.slice(0, 400);
  }).join('\n');

  const summaryInstruction = 'Summarize the conversation concisely in third person. Preserve key topics, decisions, and unfinished items. Max 400 words. Output only the summary.';
  const text = (existing_summary ? 'Previous summary:\n' + existing_summary + '\n\n---\n\nNew messages:\n' : '') + convText.slice(0, 8000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const anthropic = providerUsesAnthropicAPI(compressProvider);
    const endpoint = anthropic ? toAnthropicEndpoint(compressProvider.endpoint) : normalizeEndpoint(compressProvider.endpoint);
    const headers = anthropic
      ? { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01',
          ...(endpoint.includes('anthropic.com') ? { 'x-api-key': compressProvider.key } : { Authorization: 'Bearer ' + compressProvider.key }) }
      : { 'Content-Type': 'application/json', Authorization: 'Bearer ' + compressProvider.key };
    const body = anthropic
      ? { model: compressProvider.model, max_tokens: 600, system: summaryInstruction,
          messages: [{ role: 'user', content: text }] }
      : { model: compressProvider.model, messages: [{ role: 'system', content: summaryInstruction }, { role: 'user', content: text }], max_tokens: 600 };
    const r = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    if (!r.ok) return res.status(502).json({ error: safeUpstreamError(r) });
    const data = await r.json();
    const summary = (anthropic
      ? (data.content || []).filter(block => block.type === 'text').map(block => block.text || '').join('')
      : (data.choices?.[0]?.message?.content || '')).trim();
    if (!summary) return res.status(502).json({ error: 'Compression returned an empty summary' });
    res.json({ summary, provider: compressProvider.name, model: compressProvider.model });
  } catch (e) {
    res.status(502).json({ error: e.name === 'AbortError' ? 'Compression timed out' : 'Compression request failed' });
  } finally {
    clearTimeout(timer);
  }
});

// ============================================================
// 模型列表获取 — POST /api/models
// ============================================================
app.post('/api/models', auth, async (req, res) => {
  let { endpoint, key, providerIdx } = req.body;

  // 从已存配置补全 key
  if ((!key || key.startsWith('***')) && providerIdx !== undefined) {
    const cfg = loadConfig();
    const p = cfg.providers[providerIdx];
    if (p) { key = p.key; if (!endpoint) endpoint = p.endpoint; }
  }
  if (!endpoint || !key) return res.status(400).json({ error: 'Need endpoint and key' });

  let modelsUrl = endpoint;
  modelsUrl = modelsUrl.replace(/\/chat\/completions\/?$/, '').replace(/\/completions\/?$/, '').replace(/\/messages\/?$/, '');
  if (!modelsUrl.endsWith('/models')) {
    modelsUrl = modelsUrl.replace(/\/$/, '') + '/models';
  }

  try {
    const r = await fetch(modelsUrl, {
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }
    });
    const data = await r.json();
    let models = [];
    if (Array.isArray(data?.data)) {
      models = data.data.map(m => m.id || m.name).filter(Boolean);
    } else if (Array.isArray(data)) {
      models = data.map(m => m.id || m.name || m).filter(Boolean);
    }
    res.json({ models, url: modelsUrl });
  } catch (e) {
    res.status(500).json({ error: e.message, url: modelsUrl });
  }
});

// ============================================================
// 会话管理 CRUD
// ============================================================
app.get('/api/conversations', auth, (req, res) => {
  try {
    const files = fs.readdirSync(CONV_DIR).filter(f => f.endsWith('.json'));
    const list = files.map(f => {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(CONV_DIR, f), 'utf8'));
        return { id: c.id, title: c.title || '', u: c.u || 0, msgCount: (c.m || []).length };
      } catch (e) { return null; }
    }).filter(Boolean).sort((a, b) => b.u - a.u);
    res.json(list);
  } catch (e) { res.json([]); }
});

app.get('/api/conversations/:id', auth, (req, res) => {
  if(!/^[\w-]{1,200}$/.test(req.params.id)) return res.status(400).json({error:'invalid conversation id'});
  const fp = path.join(CONV_DIR, req.params.id + '.json');
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'not found' });
  try { res.json(JSON.parse(fs.readFileSync(fp, 'utf8'))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/conversations/:id', auth, (req, res) => {
  if(!/^[\w-]{1,200}$/.test(req.params.id)) return res.status(400).json({error:'invalid conversation id'});
  const conv = req.body;
  if (!conv || conv.id !== req.params.id || !Array.isArray(conv.m))
    return res.status(400).json({ error: 'invalid conversation' });
  const fp = path.join(CONV_DIR, conv.id + '.json');
  try {
    if(fs.existsSync(fp)) {
      const prev=JSON.parse(fs.readFileSync(fp,'utf8'));
      const knownIds=new Set(conv.m.filter(m=>m.bridge_id).map(m=>m.bridge_id));
      for(const m of (prev.m || [])) {
        if(m.source==='cc' && m.bridge_id && !knownIds.has(m.bridge_id)) {
          conv.m.push(m); knownIds.add(m.bridge_id);
        }
      }
    }
    const tmp=fp+'.tmp';fs.writeFileSync(tmp,JSON.stringify(conv),{mode:0o600});fs.renameSync(tmp,fp);
    res.json({ok:true});
  } catch(e) {res.status(500).json({error:'failed to save conversation'});}
});

app.delete('/api/conversations/:id', auth, (req, res) => {
  if(!/^[\w-]{1,200}$/.test(req.params.id)) return res.status(400).json({error:'invalid conversation id'});
  const fp = path.join(CONV_DIR, req.params.id + '.json');
  try { if (fs.existsSync(fp)) fs.unlinkSync(fp); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// 文件夹管理
// ============================================================
app.get('/api/folders', auth, (req, res) => {
  try { res.json(fs.existsSync(FOLDERS_FILE) ? JSON.parse(fs.readFileSync(FOLDERS_FILE, 'utf8')) : []); }
  catch (e) { res.json([]); }
});

app.put('/api/folders', auth, (req, res) => {
  try { fs.writeFileSync(FOLDERS_FILE, JSON.stringify(req.body)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// 贴纸管理
// ============================================================
function loadStickers() {
  try { return JSON.parse(fs.readFileSync(STICKER_FILE, 'utf8')); } catch (e) { return []; }
}
function saveStickers(s) { fs.writeFileSync(STICKER_FILE, JSON.stringify(s)); }

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

// ============================================================
// Original Hub adapter (Bridge runs as an independent local service).
// It retains the proven tmux/JSONL verification and API catch-up machinery.
// ============================================================
const BRIDGE_HTTP_PORT = Number(process.env.BRIDGE_CLIENT_PORT || 3462);
function hubProxy(req, res, endpoint, method, body) {
  const http = require('node:http');
  const token = process.env.BRIDGE_AUTH_TOKEN;
  if (!token) return res.status(503).json({ error: 'BRIDGE_AUTH_TOKEN is not configured' });
  const payload = body ? JSON.stringify(body) : null;
  const upstream = http.request({host:'127.0.0.1', port:BRIDGE_HTTP_PORT, path:endpoint,
    method, timeout:7000, headers:{'x-auth-token': token,
      ...(payload ? {'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)} : {})}}, reply => {
      res.status(reply.statusCode || 502);
      res.setHeader('Content-Type','application/json');
      reply.pipe(res);
    });
  upstream.on('timeout',()=>upstream.destroy());
  upstream.on('error',()=>{ if(!res.headersSent) res.status(502).json({error:'CC Hub unavailable'}); });
  upstream.end(payload || undefined);
}
app.get('/cc-poll', auth, (req,res) => {
  const since = Math.max(0,Number(req.query.since)||0);
  hubProxy(req,res,'/api/poll?since='+encodeURIComponent(String(since)), 'GET');
});
app.post('/cc-msg', auth, (req,res) => {
  const { content, image, images, conversation_id, cc_sync } = req.body;
  const hasImage = image && typeof image.data === 'string' && /^image\//.test(image.type || '');
  const hasImages = Array.isArray(images) && images.length > 0 && images.length <= 5 &&
    images.every(i => i && typeof i.data === 'string' && /^image\//.test(i.type || ''));
  if ((typeof content !== 'string' || !content.trim()) && !hasImage && !hasImages)
    return res.status(400).json({error:'content or image required'});
  if(typeof conversation_id !== 'string' || !/^[\w-]{1,200}$/.test(conversation_id))
    return res.status(400).json({error:'valid conversation_id required'});
  hubProxy(req,res,'/api/message','POST',{
    content:typeof content === 'string' ? content : '', conversation_id,cc_sync:cc_sync===true,
    ...(hasImage ? {image} : {}), ...(hasImages ? {images} : {})
  });
});
function readChatLogs(cid,limit) {
  try {
    const rows = fs.readFileSync(LOG_FILE,'utf8').trim().split('\n');
    return rows.slice(-1000).map(line=>{try{return JSON.parse(line)}catch{return null}})
      .filter(m=>m && m.conversation_id===cid).slice(-limit);
  } catch(e) { return []; }
}
app.get('/api/chat-log/recent', auth, (req,res)=>{
  const cid=req.query.conversation_id;
  if(typeof cid!=='string' || !/^[\w-]{1,200}$/.test(cid))
    return res.status(400).json({error:'valid conversation_id required'});
  res.json(readChatLogs(cid,Math.min(50,Math.max(1,Number(req.query.n)||10))));
});
// Original Hub's durable CC -> Classic writeback endpoint.
app.post('/api/stream/append', auth, (req,res)=>{
  const cid=req.body.cid, m=req.body.m;
  if(typeof cid!=='string'|| !/^[\w-]{1,200}$/.test(cid) || !m || m.source!=='cc'
     || m.role!=='assistant' || typeof m.content!=='string' || typeof m.bridge_id!=='string')
    return res.status(400).json({error:'invalid CC stream entry'});
  const fp=path.join(CONV_DIR,cid+'.json');
  try {
    if(!fs.existsSync(fp))return res.status(404).json({error:'conversation not found'});
    const conv=JSON.parse(fs.readFileSync(fp,'utf8'));
    if(!Array.isArray(conv.m))conv.m=[];
    if(!conv.m.some(old=>old.bridge_id===m.bridge_id)) {
      conv.m.push({role:'assistant',source:'cc',content:m.content,bridge_id:m.bridge_id,
        ts:Number(m.ts)||Date.now(),...(typeof m.thinking==='string'?{thinking:m.thinking}:{})});
      conv.u=Date.now();
      const temp=fp+'.tmp';fs.writeFileSync(temp,JSON.stringify(conv),{mode:0o600});fs.renameSync(temp,fp);
    }
    res.json({ok:true});
  } catch(e) {res.status(500).json({error:'failed to persist reply'});}
});

// ============================================================
// 健康检查
// ============================================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    ts: new Date().toISOString(),
    cc_alive: null // CC state is maintained by the separate Hub
  });
});

// ============================================================
// 启动服务
// ============================================================
app.listen(PORT, '127.0.0.1', () => {
  console.log('cc-companion chat-server on 127.0.0.1:' + PORT);
  if (!PASSWORD) {
    console.log('[WARN] CHAT_PASSWORD 未设置 — API 对 localhost 完全开放');
  }
});
