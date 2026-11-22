import {describe,it,expect,vi} from 'vitest';
import {chatDatabase} from './helpers/chat-db.mjs';
import {handleChat} from '../src/chat.ts';
import {keyedHash} from '../src/crypto.ts';
import {UserInbox} from '../chat/worker/src/do/UserInbox.js';
import {createInternalHeaders} from '../chat/worker/src/verified-identity.js';
import {createWebPush} from '../chat/frontend/src/web-push.js';

it('registers from the real cookie-authenticated gateway and sends system push after all pages disconnect',async()=>{
 const db=await chatDatabase();
 try {
  const env={...db.env,SESSION_SECRET:'integration-test-only-session-secret-32-characters'};
  db.sqlite.prepare("UPDATE identity_codes SET password_hash='test-password' WHERE id='a'").run();
  const token=crypto.randomUUID()+crypto.randomUUID();
  db.sqlite.prepare('INSERT INTO identity_web_sessions(token_hash,identity_code_id,code_hash,password_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)').run(await keyedHash(env,'identity-web-session',token),'a','a','test-password',new Date(Date.now()+3600000).toISOString(),new Date().toISOString());
  const data=new Map(),pending=[];
  const storage={get:async key=>structuredClone(data.get(key)),put:async(key,value)=>data.set(key,structuredClone(value)),transaction:async fn=>fn(storage)};
  const inbox=new UserInbox({storage,getWebSockets:()=>[],blockConcurrencyWhile:fn=>fn(),waitUntil:p=>pending.push(p)},env);
  env.USER_INBOX={idFromName:name=>name,get:name=>{expect(name).toBe('user:'+db.users[0].id);return {fetch:(request,init)=>inbox.fetch(request instanceof Request?request:new Request(request,init))};}};
  async function api(path,body) {
   const response=await handleChat(new Request('https://camp.example/chat/api/push/'+path,{method:body?'PUT':'GET',headers:{Cookie:'__Host-mrzh_identity='+token,Origin:'https://camp.example','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),env);
   expect(response.status).toBe(200);return response.json();
  }
  const receiver=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const subscription={endpoint:'https://web.push.apple.com/integration-test',keys:{p256dh:Buffer.from(await crypto.subtle.exportKey('raw',receiver.publicKey)).toString('base64url'),auth:Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url')}};
  const values=new Map(),local={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
  const manager={getSubscription:async()=>null,subscribe:async options=>({options,toJSON:()=>subscription})};
  vi.stubGlobal('document',{documentElement:{lang:'ja-JP'}});
  const client=createWebPush({storage:local,navigator:{serviceWorker:{register:async()=>({active:{},pushManager:manager})}},apiClient:{pushKey:()=>api('key'),savePushSubscription:body=>api('subscription',body)}});
  await client.sync(true,[]);expect(client.subscribed).toBe(true);
  const stored=Object.values(data.get('web-push:v1:devices'))[0];
  expect(stored).toMatchObject({userId:db.users[0].id,token,subject:'https://camp.example',language:'ja-JP'});
  const send=vi.fn(async()=>new Response(null,{status:201}));vi.stubGlobal('fetch',send);
  for(const kind of ['public','private','dm']) await inbox.fetch(new Request('https://chat.internal/notify',{method:'POST',headers:createInternalHeaders({'Content-Type':'application/json'}),body:JSON.stringify({type:'room_message',messageId:55,room:{kind,id:2,name:'Room'},sender:{displayName:'Bob'},contentPreview:'A short overview'})}));
  await Promise.all(pending);
  expect(send).toHaveBeenCalledTimes(3);
  for(const [url,init] of send.mock.calls){
   expect(url).toBe(subscription.endpoint);expect(init.headers['content-encoding']).toBe('aes128gcm');
   const claims=JSON.parse(Buffer.from(init.headers.authorization.match(/vapid t=([^,]+)/)[1].split('.')[1],'base64url').toString());
   expect(claims.sub).toBe('https://camp.example');expect(claims.aud).toBe('https://web.push.apple.com');
  }
 }finally{vi.unstubAllGlobals();db.close();}
});
