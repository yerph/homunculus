'use strict';
const http = require('http');
function forwardAPIContext(entry, token, enabled, options = {}) {
  if (enabled !== true || !entry || !entry.conversation_id || !token) return Promise.resolve(false);
  return new Promise(resolve => {
    const body = JSON.stringify({cc_sync:true,entry});
    const req = http.request({host:'127.0.0.1',port:options.port || Number(process.env.BRIDGE_CLIENT_PORT || 3462),path:'/api/api-context',method:'POST',
      headers:{'content-type':'application/json','x-auth-token':token,'content-length':Buffer.byteLength(body)}},res=>{
      res.resume();res.on('end',()=>resolve(res.statusCode===200));res.on('error',()=>resolve(false));
    });
    req.on('error',()=>resolve(false));req.setTimeout(3000,()=>{req.destroy();resolve(false);});req.end(body);
  });
}
module.exports = {forwardAPIContext};
