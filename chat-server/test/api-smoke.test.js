'use strict';
// Isolated mock API tests. No live provider calls, credentials, or user records.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}
async function run() {
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    requests.push({ url: req.url, body });
    if (req.url.includes('/failure')) {
      res.writeHead(400, {'Content-Type':'text/plain'});
      res.end('dangerous upstream error: token=private-placeholder');
    } else if (body.stream && req.url.endsWith('/messages')) {
      res.writeHead(200, {'Content-Type':'text/event-stream'});
      res.end('data: '+JSON.stringify({ type:'content_block_start', index:0, content_block:{type:'text',text:''} })+'\n\n'
        +'data: '+JSON.stringify({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'anthropic-ok'}})+'\n\n'
        +'data: '+JSON.stringify({type:'message_stop'})+'\n\n');
    } else if (body.stream) {
      res.writeHead(200, {'Content-Type':'text/event-stream'});
      res.end('data: '+JSON.stringify({ choices:[{delta:{content:'openai-ok'}}] })+'\n\n'+'data: [DONE]\n\n');
    } else if (req.url.endsWith('/messages')) {
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({content:[{type:'text',text:'anthropic-summary'}]}));
    } else {
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({choices:[{message:{content:'deepseek-summary'}}]}));
    }
  });
  const upPort = await listen(upstream);
  const portServer = http.createServer((_req,res)=>res.end());
  const chatPort = await listen(portServer); await new Promise(r=>portServer.close(r));
  // Server files and config are placed in an isolated temporary copy.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'homunculus-api-test-'));
  const original = path.resolve(__dirname, '..');
  for (const file of ['server.js','package.json']) fs.copyFileSync(path.join(original,file),path.join(temp,file));
  fs.symlinkSync(path.join(original,'node_modules'),path.join(temp,'node_modules'));
  fs.symlinkSync(path.join(original,'lib'),path.join(temp,'lib'));
  fs.mkdirSync(path.join(temp,'data'));
  const configFile = path.join(temp,'data','config.json');
  const endpoint = `http://127.0.0.1:${upPort}/v1/chat/completions`;
  const makeProvider = (name,endpoint,model,extra={})=>({name,endpoint,model,key:'test-placeholder',active:false,...extra});
  const config = {providers:[makeProvider('Mock OpenAI',endpoint,'mock-chat',{active:true}),makeProvider('DeepSeek',endpoint,'mock-summary')],system_prompt:''};
  fs.writeFileSync(configFile, JSON.stringify(config));
  let child;
  const base = `http://127.0.0.1:${chatPort}`;
  const post = async (route, body) => {
    const r = await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','x-auth-token':'test-password'},body:JSON.stringify(body)});
    return {status:r.status,body:await r.text()};
  };
  try {
    child=spawn(process.execPath,['server.js'],{cwd:temp,env:{...process.env,CHAT_PORT:String(chatPort),CHAT_PASSWORD:'test-password',BRIDGE_AUTH_TOKEN:'test-bridge-secret'},stdio:'ignore'});
    let ready=false;
    for(let i=0;i<80;i++) { try { const r=await fetch(base+'/api/health');if(r.ok){ready=true;break;} }catch{} await new Promise(r=>setTimeout(r,50)); }
    assert.ok(ready,'server started');
    const chat=await post('/api/chat',{messages:[{role:'user',content:'hello'}],thinking:false});
    assert.equal(chat.status,200); assert.match(chat.body,/openai-ok/);
    const upstreamChat=requests.find(r=>r.body.stream && r.body.model==='mock-chat');
    assert.ok(upstreamChat);assert.equal(upstreamChat.body.thinking,undefined);assert.equal(upstreamChat.body.reasoning,undefined);
    const comp=await post('/api/compress',{messages:[{role:'user',content:'Example nonpersonal conversation'}]});
    assert.equal(comp.status,200);assert.equal(JSON.parse(comp.body).summary,'deepseek-summary');
    let c=JSON.parse(fs.readFileSync(configFile));
    c.providers[0].active=false;c.providers[1].active=true;
    c.providers[1].api_format='anthropic';c.providers[1].endpoint=`http://127.0.0.1:${upPort}/v1/messages`;
    fs.writeFileSync(configFile,JSON.stringify(c));
    const native=await post('/api/chat',{messages:[{role:'user',content:'hi'}],thinking:false});
    assert.equal(native.status,200);assert.match(native.body,/anthropic-ok/);
    const nativeComp=await post('/api/compress',{messages:[{role:'user',content:'Example'}]});
    assert.equal(nativeComp.status,200);assert.equal(JSON.parse(nativeComp.body).summary,'anthropic-summary');
    c.providers[1].api_format='openai';c.providers[1].endpoint=`http://127.0.0.1:${upPort}/failure/chat/completions`;
    fs.writeFileSync(configFile,JSON.stringify(c));
    const fail=await post('/api/chat',{messages:[{role:'user',content:'hello'}]});
    assert.equal(fail.status,200);assert.match(fail.body,/HTTP 400/);assert.doesNotMatch(fail.body,/private-placeholder/);
    // Masked keys should remain attached to provider names even when reordered.
    c.providers=[makeProvider('Alpha',endpoint,'a',{key:'alpha-placeholder'}),makeProvider('Beta',endpoint,'b',{key:'beta-placeholder'})];
    fs.writeFileSync(configFile,JSON.stringify(c));
    const reordered=await post('/api/config',{providers:[{...c.providers[1],key:'***holder'},{...c.providers[0],key:'***holder'}]});
    assert.equal(reordered.status,200);
    const saved=JSON.parse(fs.readFileSync(configFile)).providers;
    assert.equal(saved[0].key,'beta-placeholder');assert.equal(saved[1].key,'alpha-placeholder');
    console.log('PASS: API formats, compression, errors, provider key mapping');
  } finally {
    if(child) { child.kill('SIGTERM');await new Promise(resolve=>{child.once('exit',resolve);setTimeout(resolve,1000);}); }
    await new Promise(resolve=>upstream.close(resolve));
    fs.rmSync(temp,{recursive:true,force:true});
  }
}
test('API mode smoke tests with fake providers',run);
