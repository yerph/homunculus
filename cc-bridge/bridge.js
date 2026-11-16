// Original MCP web-channel bridge, private work-ticket extension omitted.
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const WebSocket = require('ws');

const HUB_URL = 'ws://127.0.0.1:' + (process.env.BRIDGE_INTERNAL_PORT || 3463);

let hub = null;
let hubReady = false;
let reqCounter = 0;
const pending = new Map();

function connectHub() {
  hub = new WebSocket(HUB_URL);
  hub.on('open', function() {
    hubReady = true;
  });
  hub.on('message', function(raw) {
    try {
      var msg = JSON.parse(raw);
      if (msg._req_id && pending.has(msg._req_id)) {
        var p = pending.get(msg._req_id);
        clearTimeout(p.timer);
        pending.delete(msg._req_id);
        p.resolve(msg);
      }
    } catch(e) {}
  });
  hub.on('close', function() {
    hubReady = false;
    hub = null;
    setTimeout(connectHub, 2000);
  });
  hub.on('error', function() {});
}

function hubRequest(msg) {
  return new Promise(function(resolve, reject) {
    if (!hub || !hubReady) return reject(new Error('hub not connected'));
    var id = 'req_' + (++reqCounter);
    var timer = setTimeout(function() {
      pending.delete(id);
      reject(new Error('timeout'));
    }, 10000);
    pending.set(id, { resolve: resolve, timer: timer });
    hub.send(JSON.stringify(Object.assign({}, msg, { _req_id: id })));
  });
}

connectHub();

var server = new Server(
  { name: 'web-channel', version: '1.0.0' },
  {
    capabilities: { tools: {} },
    instructions: [
      'Messages from the web chat arrive as <channel source="web" chat_id="..." message_id="..." user="..." ts="...">.',
      'Reply with the reply tool — pass chat_id back. ',
    ].join('\n'),
  }
);

server.setRequestHandler(ListToolsRequestSchema, async function() {
  return {
    tools: [
      {
        name: 'reply',
        description: 'Reply to a web chat message. Include thinking summary and tools_used when available.',
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: { type: 'string', description: 'client_id from the inbound channel tag' },
            text: { type: 'string', description: 'Reply text' },
            reply_to: { type: 'string', description: 'Message ID to quote-reply (optional)' },
            thinking: { type: 'string', description: 'Brief summary of your thinking/reasoning process for this reply (optional, shown to user as collapsible panel)' },
            tools_used: { type: 'array', description: 'Tools called during this turn', items: { type: 'object', properties: { name: { type: 'string' }, args: { type: 'string' }, result: { type: 'string' } } } },
          },
          required: ['chat_id', 'text'],
        },
      },
      {
        name: 'edit_message',
        description: 'Edit a previously sent web chat message',
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: { type: 'string', description: 'client_id' },
            message_id: { type: 'string', description: 'Message ID to edit' },
            text: { type: 'string', description: 'New text' },
          },
          required: ['chat_id', 'message_id', 'text'],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async function(request) {
  var name = request.params.name;
  var args = request.params.arguments || {};

  if (name === 'reply') {
    try {
      var msg = { type: 'reply', text: args.text, chat_id: args.chat_id, reply_to: args.reply_to };
      if (args.thinking) msg.thinking = args.thinking;
      if (args.tools_used) msg.tools_used = args.tools_used;
      var result = await hubRequest(msg);
      return { content: [{ type: 'text', text: 'sent (id: ' + (result.id || '?') + ')' }] };
    } catch(e) {
      return { content: [{ type: 'text', text: 'error: ' + e.message }], isError: true };
    }
  }


  if (name === 'edit_message') {
    try {
      var result = await hubRequest({ type: 'edit', message_id: args.message_id, text: args.text, chat_id: args.chat_id });
      return { content: [{ type: 'text', text: 'edited' }] };
    } catch(e) {
      return { content: [{ type: 'text', text: 'error: ' + e.message }], isError: true };
    }
  }

  return { content: [{ type: 'text', text: 'unknown tool: ' + name }], isError: true };
});

async function main() {
  var transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(function(e) { process.exit(1); });
