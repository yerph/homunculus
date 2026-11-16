'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {spawn}=require('node:child_process');
const {createInbox}=(()=>({createInbox:require('../../cc-bridge/api-sync-inbox')}))();
const {forwardAPIContext}=require('../lib/api-sync');

function openPort() {return new Promise((resolve,reject)=>{
  const s=net.createServer();s.once('error',reject);
  s.listen(0,'127.0.0.1',()=>{const n=s.address().port;s.close(()=>resolve(n));});
});}
async function untilHealthy(port) {
  for(let i=0;i<80;i++) {
    try{const r=await fetch(`http://127.0.0.1:${port}/health`);if(r.ok)return;}catch{}
    await new Promise(r=>setTimeout(r,50));
  }
  throw new Error('original Hub did not become healthy');
}
test('sanitized original Hub preserves API push inbox, scoped data, bridge auth and localhost startup',async()=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'original-hub-'));
  const port=await openPort(),wsPort=await openPort();
  const token='mock-hub-secret';
  const hub=spawn(process.execPath,[path.resolve(__dirname,'../../cc-bridge/hub.js')],{
    env:{...process.env,BRIDGE_AUTH_TOKEN:token,CHAT_PASSWORD:'mock-web-password',
      BRIDGE_CLIENT_PORT:String(port),BRIDGE_INTERNAL_PORT:String(wsPort),
      BRIDGE_CC_SESSION_DIR:path.join(data,'no-such-session'),BRIDGE_TMUX:'isolated-test-session',
      BRIDGE_DATA_DIR:data},stdio:'ignore'
  });
  try {
    await untilHealthy(port);
    const entry={conversation_id:'synthetic-c',ts:new Date().toISOString(),user:'test user',assistant:'test assistant',via:'api'};
    assert.equal(await forwardAPIContext(entry,token,true,{port}),true);
    assert.equal(await forwardAPIContext(entry,token,true,{port}),true,'identical push is deduplicated');
    assert.equal(await forwardAPIContext({...entry,conversation_id:'other-c'},token,false,{port}),false);
    const saved=JSON.parse(fs.readFileSync(path.join(data,'api-sync-inbox.json'),'utf8'));
    assert.equal(saved.length,1);
    assert.equal(saved[0].conversation_id,'synthetic-c');
    assert.equal(saved[0].user,'test user');
    const unauthPoll=await fetch(`http://127.0.0.1:${port}/api/poll`);
    assert.equal(unauthPoll.status,403);
    const goodPoll=await fetch(`http://127.0.0.1:${port}/api/poll?since=0`,{headers:{'x-auth-token':token}});
    assert.equal(goodPoll.status,200);
    const blockedMessage=await fetch(`http://127.0.0.1:${port}/api/message`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:'denied'})});
    assert.equal(blockedMessage.status,403);
    // Real original Hub WebSocket -> poll route, with a synthetic reply only.
    const WS=require('../../cc-bridge/node_modules/ws');
    const ws=new WS(`ws://127.0.0.1:${wsPort}`);
    await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject)});
    ws.send(JSON.stringify({type:'reply',text:'synthetic CC response'}));
    let received=false;
    for(let i=0;i<20;i++) {
      const out=await fetch(`http://127.0.0.1:${port}/api/poll?since=0`,{headers:{'x-auth-token':token}});
      const payload=await out.json();
      if(payload.messages.some(m=>m.type==='message' && m.role==='assistant' && m.content==='synthetic CC response')) {received=true;break;}
      await new Promise(r=>setTimeout(r,50));
    }
    assert.equal(received,true,'original CC WebSocket reply reaches polling clients');
    ws.close();
  } finally {
    hub.kill('SIGTERM');
    await Promise.race([new Promise(resolve=>hub.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,2000))]);
    if(hub.exitCode===null)hub.kill('SIGKILL');
    fs.rmSync(data,{recursive:true,force:true});
  }
});

test('original inbox separates conversation IDs and rejects unscoped turns',()=>{
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'original-inbox-'));
  try {
    const inbox=createInbox(path.join(data,'inbox.json'));
    const a={conversation_id:'c1',user:'one',assistant:'response',ts:new Date().toISOString(),via:'api'};
    assert.equal(inbox.accept({cc_sync:true,entry:a}),true);
    assert.equal(inbox.accept({cc_sync:true,entry:a}),true);
    assert.equal(inbox.accept({cc_sync:true,entry:{...a,conversation_id:'c2'}}),true);
    assert.equal(inbox.recent('c1').length,1);
    assert.equal(inbox.recent('c2').length,1);
    assert.equal(inbox.accept({cc_sync:true,entry:{...a,conversation_id:''}}),false);
  } finally {fs.rmSync(data,{recursive:true,force:true});}
});
