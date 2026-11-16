'use strict';
const fs = require('fs');
const crypto = require('crypto');
const key = m => crypto.createHash('sha256').update(JSON.stringify([m.conversation_id,m.ts,m.user,m.assistant,m.via])).digest('hex');
module.exports = function createInbox(file) {
  let turns=[];
  try {const saved=JSON.parse(fs.readFileSync(file,'utf8'));if(Array.isArray(saved))turns=saved.slice(-200);}catch(_){}
  return {
    accept(payload) {
      const m=payload && payload.entry;
      if(payload.cc_sync!==true || !m || typeof m.conversation_id!=='string' || !m.conversation_id || m.conversation_id.length>200 ||
         typeof m.user!=='string' || typeof m.assistant!=='string' || typeof m.ts!=='string' || !Number.isFinite(Date.parse(m.ts)))return false;
      if(m.user.length>1000000 || m.assistant.length>1000000)return false;
      const entry={conversation_id:m.conversation_id,ts:m.ts,user:m.user,assistant:m.assistant,via:m.via==='cli'?'cli':'api'};
      if(turns.some(t=>key(t)===key(entry)))return true;
      const next=turns.concat(entry).slice(-200);
      fs.writeFileSync(file+'.tmp',JSON.stringify(next),{mode:0o600});fs.renameSync(file+'.tmp',file);turns=next;return true;
    },
    recent(cid) {return turns.filter(m=>m.conversation_id===cid).slice(-50);}
  };
};
