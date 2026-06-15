/**
 * MCP Bridge — stdio server that connects Claude Code to the phone widget hub.
 *
 * Claude Code runs this as an MCP server. It exposes two tools:
 *   - reply:        send a message back to the web chat
 *   - edit_message: edit a previously sent message
 *
 * Internally it connects to the hub via WebSocket on BRIDGE_PORT.
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const WebSocket = require('ws');

/* CUSTOMIZE: must match BRIDGE_PORT in server.js */
const HUB_URL = 'ws://127.0.0.1:' + (process.env.BRIDGE_PORT || 4601);

let hub = null;
let hubReady = false;
let reqCounter = 0;
const pending = new Map();

/* ============================================================
 *  Hub WebSocket connection (auto-reconnect)
 * ============================================================ */

function connectHub() {
  hub = new WebSocket(HUB_URL);

  hub.on('open', function () {
    hubReady = true;
    console.error('[bridge] connected to hub at ' + HUB_URL);
  });

  hub.on('message', function (raw) {
    try {
      var msg = JSON.parse(raw);
      if (msg._req_id && pending.has(msg._req_id)) {
        var p = pending.get(msg._req_id);
        clearTimeout(p.timer);
        pending.delete(msg._req_id);
        p.resolve(msg);
      }
    } catch (e) { /* ignore */ }
  });

  hub.on('close', function () {
    hubReady = false;
    hub = null;
    console.error('[bridge] disconnected from hub, reconnecting in 2s...');
    setTimeout(connectHub, 2000);
  });

  hub.on('error', function () { /* handled by close */ });
}

function hubRequest(msg) {
  return new Promise(function (resolve, reject) {
    if (!hub || !hubReady) return reject(new Error('hub not connected'));
    var id = 'req_' + (++reqCounter);
    var timer = setTimeout(function () {
      pending.delete(id);
      reject(new Error('timeout'));
    }, 10000);
    pending.set(id, { resolve: resolve, timer: timer });
    hub.send(JSON.stringify(Object.assign({}, msg, { _req_id: id })));
  });
}

connectHub();

/* ============================================================
 *  MCP Server definition
 * ============================================================ */

var server = new Server(
  /* CUSTOMIZE: change the server name to match your project */
  { name: 'web-channel', version: '1.0.0' },
  {
    capabilities: { tools: {} },
    instructions: [
      'Messages from the web chat arrive as <channel source="web" chat_id="..." message_id="..." user="..." ts="...">.',
      'Reply with the reply tool — pass chat_id back.',
    ].join('\n'),
  }
);

/* --- List tools --- */

server.setRequestHandler(ListToolsRequestSchema, async function () {
  return {
    tools: [
      {
        name: 'reply',
        description: 'Reply to a web chat message.',
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: { type: 'string', description: 'client_id from the inbound channel tag' },
            text:    { type: 'string', description: 'Reply text' },
            reply_to: { type: 'string', description: 'Message ID to quote-reply (optional)' },
          },
          required: ['chat_id', 'text'],
        },
      },
      {
        name: 'edit_message',
        description: 'Edit a previously sent web chat message.',
        inputSchema: {
          type: 'object',
          properties: {
            chat_id:    { type: 'string', description: 'client_id' },
            message_id: { type: 'string', description: 'Message ID to edit' },
            text:       { type: 'string', description: 'New text' },
          },
          required: ['chat_id', 'message_id', 'text'],
        },
      },
    ],
  };
});

/* --- Call tools --- */

server.setRequestHandler(CallToolRequestSchema, async function (request) {
  var name = request.params.name;
  var args = request.params.arguments || {};

  if (name === 'reply') {
    try {
      var msg = { type: 'reply', text: args.text, chat_id: args.chat_id };
      if (args.reply_to) msg.reply_to = args.reply_to;
      var result = await hubRequest(msg);
      return { content: [{ type: 'text', text: 'sent (id: ' + (result.id || '?') + ')' }] };
    } catch (e) {
      return { content: [{ type: 'text', text: 'error: ' + e.message }], isError: true };
    }
  }

  if (name === 'edit_message') {
    try {
      var result = await hubRequest({ type: 'edit', message_id: args.message_id, text: args.text, chat_id: args.chat_id });
      return { content: [{ type: 'text', text: 'edited' }] };
    } catch (e) {
      return { content: [{ type: 'text', text: 'error: ' + e.message }], isError: true };
    }
  }

  return { content: [{ type: 'text', text: 'unknown tool: ' + name }], isError: true };
});

/* --- Start --- */

async function main() {
  var transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[bridge] MCP server running on stdio');
}

main().catch(function (e) {
  console.error('[bridge] fatal: ' + e.message);
  process.exit(1);
});
