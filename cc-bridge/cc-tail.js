const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const SESSION_DIR = process.env.BRIDGE_CC_SESSION_DIR || '';
class CCTail extends EventEmitter {
  constructor() {
    super();
    this._watcher = null;
    this._file = null;
    this._offset = 0;
    this._buf = '';
    this._syncTimer = null;
    this._reading = false;
    this._pending = false;
    this._gen = 0;
  }

  findCurrentSession() {
    try {
      const files = fs.readdirSync(SESSION_DIR)
        .filter(f => f.endsWith('.jsonl') && !f.includes('subagent'))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(SESSION_DIR, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      return files.length ? path.join(SESSION_DIR, files[0].name) : null;
    } catch (e) { return null; }
  }

  _adopt(file, fromStart) {
    this.stop();
    this._gen++;
    this._file = file;
    this._buf = '';
    this._reading = false;
    this._pending = false;
    let size = 0;
    try { size = fs.statSync(file).size; } catch (e) {}
    if (fromStart) {
      this._offset = size > 262144 ? size - 65536 : 0;  // 文件太大只补最近64K, 防洪
    } else {
      this._offset = size;
    }
    try { this._watcher = fs.watch(file, () => this._read()); } catch (e) { this._watcher = null; }
    console.log('[cc-tail] watching', path.basename(file), 'from offset', this._offset);
    if (this._offset < size) this._read();
  }

  start() {
    const file = this.findCurrentSession();
    if (!file) return;
    this._adopt(file, false);  // hub启动: 跳过旧历史, 只跟新增
  }

  // 每2秒: 最新会话文件变了就自动切过去(从头读, 前端按uuid去重);
  // 没变则stat兜底fs.watch丢事件的情况
  startAutoSync() {
    if (this._syncTimer) return;
    this._syncTimer = setInterval(() => {
      try {
        const cur = this.findCurrentSession();
        if (cur && cur !== this._file) {
          this._adopt(cur, true);
          this.emit('switch', cur);
        } else if (this._file) {
          const st = fs.statSync(this._file);
          if (st.size > this._offset) this._read();
        }
      } catch (e) {}
    }, 2000);
  }

  stop() {
    if (this._watcher) { this._watcher.close(); this._watcher = null; }
  }

  switchSession() {
    const cur = this.findCurrentSession();
    if (!cur) return;
    if (cur !== this._file) { this._adopt(cur, true); this.emit('switch', cur); }
    else { this._adopt(cur, false); }
  }

  _read() {
    if (!this._file) return;
    if (this._reading) { this._pending = true; return; }
    let stat;
    try { stat = fs.statSync(this._file); } catch (e) { return; }
    if (stat.size <= this._offset) return;

    this._reading = true;
    const gen = this._gen;
    const stream = fs.createReadStream(this._file, { start: this._offset, encoding: 'utf8' });
    let chunk = '';
    stream.on('data', d => { chunk += d; });
    stream.on('error', () => { if (gen === this._gen) this._reading = false; });
    stream.on('end', () => {
      if (gen !== this._gen) return;  // 中途切换了会话, 丢弃
      this._offset = stat.size;
      this._buf += chunk;
      const lines = this._buf.split('\n');
      this._buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          const parsed = this._parse(entry);
          if (parsed) this.emit('entry', parsed);
        } catch (e) {}
      }
      this._reading = false;
      if (this._pending) { this._pending = false; this._read(); }
    });
  }

  _parse(entry) {
    const t = entry.type;
    if (t === 'assistant') return this._parseAssistant(entry);
    if (t === 'user') return this._parseUser(entry);
    if (t === 'system') return { type: 'system', ts: entry.timestamp };
    return null;
  }

  _parseAssistant(entry) {
    const content = (entry.message || {}).content || [];
    if (!Array.isArray(content)) return null;

    const blocks = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'thinking') {
        blocks.push({ type: 'thinking', text: block.thinking || '', hasSignature: !!block.signature });
      } else if (block.type === 'text') {
        blocks.push({ type: 'text', text: block.text || '' });
      } else if (block.type === 'tool_use') {
        blocks.push({
          type: 'tool_use',
          name: block.name || '',
          id: block.id || '',
          input: this._summarizeInput(block.name, block.input)
        });
      }
    }

    if (!blocks.length) return null;
    return {
      type: 'assistant',
      uuid: entry.uuid,
      parentUuid: entry.parentUuid,
      ts: entry.timestamp,
      blocks
    };
  }

  _parseUser(entry) {
    const content = (entry.message || {}).content || [];
    let text = '';
    let isToolResult = false;
    let isErr = false;
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (b && b.type === 'tool_result') {
          isToolResult = true;
          if (b.is_error) isErr = true;
        }
      }
      text = content
        .filter(b => b && b.type === 'text')
        .map(b => b.text || '')
        .join('\n');
    }
    const out = {
      type: 'user',
      uuid: entry.uuid,
      ts: entry.timestamp,
      text: text.slice(0, 500)
    };
    if (isToolResult) { out.isToolResult = true; out.is_error = isErr; }
    return out;
  }

  _summarizeInput(toolName, input) {
    if (!input) return '';
    if (toolName === 'Bash') return input.command || '';
    if (toolName === 'Read') return input.file_path || '';
    if (toolName === 'Write' || toolName === 'Edit') return input.file_path || '';
    if (toolName === 'WebSearch') return input.query || '';
    if (toolName === 'WebFetch') return input.url || '';
    if (toolName === 'Agent') return input.description || '';
    if (typeof input === 'object') {
      const keys = Object.keys(input);
      if (keys.length <= 3) {
        return keys.map(k => {
          const v = input[k];
          const s = typeof v === 'string' ? v : JSON.stringify(v);
          return k + ': ' + (s.length > 80 ? s.slice(0, 80) + '...' : s);
        }).join(', ');
      }
      return keys.join(', ');
    }
    return String(input).slice(0, 100);
  }

  listSessions() {
    try {
      return fs.readdirSync(SESSION_DIR)
        .filter(f => f.endsWith('.jsonl') && !f.includes('subagent'))
        .map(f => {
          const fp = path.join(SESSION_DIR, f);
          const stat = fs.statSync(fp);
          return {
            id: f.replace('.jsonl', ''),
            file: f,
            size: stat.size,
            modified: stat.mtime.toISOString(),
            active: fp === this._file
          };
        })
        .sort((a, b) => new Date(b.modified) - new Date(a.modified));
    } catch (e) { return []; }
  }
}

module.exports = CCTail;
