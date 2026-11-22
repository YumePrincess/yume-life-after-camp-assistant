import {describe,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {loadPushKey,validSubscription,pushNotification,sendWebPush} from '../chat/worker/src/push.js';
const b64 = data=>Buffer.from(data).toString('base64url');
async function subscription(endpoint='https://web.push.apple.com/test') {
 const pair = await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
 return {endpoint,expirationTime:null,keys:{p256dh:b64(await crypto.subtle.exportKey('raw',pair.publicKey)),auth:b64(crypto.getRandomValues(new Uint8Array(16)))}};
}
describe('Web Push encryption and input validation',()=>{
 it('persists one VAPID identity and produces an encrypted Apple-compatible request',async()=>{
  const values = new Map(), storage={get:async k=>values.get(k),put:async(k,v)=>values.set(k,v)};
  const key=await loadPushKey(storage);
  expect(await loadPushKey(storage)).toEqual(key);
  const sub=await subscription();
  expect(validSubscription(sub)).toBe(true);
  const fetcher=vi.fn(async()=>new Response(null,{status:201}));
  const notification=pushNotification({room:{kind:'public',id:1,name:'general'},messageId:55},'ja-JP');
  expect(notification.title).toBe('全メンバーグループ');
  expect(await sendWebPush(sub,key,notification,'https://camp.example',fetcher)).toBe(201);
  const [url,init]=fetcher.mock.calls[0];
  expect(url).toBe(sub.endpoint);
  const headers=new Headers(init.headers);
  expect(headers.get('Content-Encoding')).toBe('aes128gcm');
  expect(headers.get('Authorization')).toMatch(/^vapid t=.+, k=.+/);
  expect(headers.get('TTL')).toBe('3600');
  expect(headers.get('Urgency')).toBe('high');
  expect(Buffer.from(init.body).includes(Buffer.from(notification.title))).toBe(false);
 });
 it('rejects non-push hosts, redirects through credentials, insecure URLs and invalid encryption keys',async()=>{
  const sub=await subscription();
  for(const endpoint of ['http://web.push.apple.com/x','https://localhost/x','https://web.push.apple.com.evil.example/x','https://user:secret@web.push.apple.com/x','https://web.push.apple.com:8443/x']) expect(validSubscription({...sub,endpoint})).toBe(false);
  expect(validSubscription({...sub,keys:{...sub.keys,auth:'broken'}})).toBe(false);
 });
});

// Decrypt the actual wire payload as a browser does, then deliver it to the shipped Service Worker.
async function decryptPush(body, receiver, auth) {
 const bytes = new Uint8Array(body);
 const salt = bytes.slice(0,16), senderPublic = bytes.slice(21,21+bytes[20]);
 const peer = await crypto.subtle.importKey('raw',senderPublic,{name:'ECDH',namedCurve:'P-256'},false,[]);
 const shared = await crypto.subtle.deriveBits({name:'ECDH',public:peer},receiver.privateKey,256);
 const receiverPublic = new Uint8Array(await crypto.subtle.exportKey('raw',receiver.publicKey));
 const info = Buffer.concat([Buffer.from('WebPush: info\0'),receiverPublic,senderPublic]);
 async function hkdf(input,salt,info,length) {
  const key = await crypto.subtle.importKey('raw',input,'HKDF',false,['deriveBits']);
  return crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt,info},key,length*8);
 }
 const ikm = await hkdf(shared,auth,info,32);
 const cek = await hkdf(ikm,salt,Buffer.from('Content-Encoding: aes128gcm\0'),16);
 const nonce = await hkdf(ikm,salt,Buffer.from('Content-Encoding: nonce\0'),12);
 const key = await crypto.subtle.importKey('raw',cek,'AES-GCM',false,['decrypt']);
 const plain = new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:nonce},key,bytes.slice(21+bytes[20])));
 let end = plain.length-1;
 while (plain[end] === 0) end--;
 expect(plain[end]).toBe(2);
 return JSON.parse(new TextDecoder().decode(plain.slice(0,end)));
}
describe('encrypted push delivery to the installed Service Worker',()=>{
 for (const kind of ['public','private','dm']) it(`displays and deep-links a real ${kind} payload`,async()=>{
  const receiver = await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const sub = {endpoint:'https://web.push.apple.com/test',keys:{p256dh:b64(await crypto.subtle.exportKey('raw',receiver.publicKey)),auth:b64(auth)}};
  const values=new Map(); const key=await loadPushKey({get:async k=>values.get(k),put:async(k,v)=>values.set(k,v)});
  let payload;
  await sendWebPush(sub,key,pushNotification({room:{kind,id:3,name:kind==='dm'?'Alice':'general'},messageId:8},'zh-CN'),'https://camp.example',async(_url,init)=>{
   payload=await decryptPush(init.body,receiver,auth);return new Response(null,{status:201});
  });
  const handlers={};const showNotification=vi.fn(async()=>{}),openWindow=vi.fn(async()=>{});
  const self={location:{origin:'https://camp.example'},addEventListener:(name,fn)=>handlers[name]=fn,registration:{showNotification},clients:{matchAll:async()=>[],openWindow}};
  runInNewContext(readFileSync(new URL('../public/sw.js',import.meta.url),'utf8'),{self,URL});
  let pending; handlers.push({data:{json:()=>payload},waitUntil:p=>pending=p});await pending;
  expect(showNotification).toHaveBeenCalledWith(kind==='dm'?'Alice':'全体成员群',expect.objectContaining({data:{roomKind:kind,roomId:3,messageId:8}}));
  handlers.notificationclick({notification:{close(){},data:payload.data},waitUntil:p=>pending=p});await pending;
  expect(openWindow).toHaveBeenCalledWith(`https://camp.example/?chatRoom=${kind}%3A3#chat`);
 });
});

describe('push transport failure visibility',()=>{
 it('reports provider rejection instead of claiming delivery, while expired subscriptions can be removed',async()=>{
  const values=new Map(),key=await loadPushKey({get:async k=>values.get(k),put:async(k,v)=>values.set(k,v)}),sub=await subscription();
  const notification=pushNotification({room:{kind:'dm',id:1,name:'Alice'},messageId:2},'en');
  await expect(sendWebPush(sub,key,notification,'https://camp.example',async()=>new Response(null,{status:403}))).rejects.toMatchObject({status:403});
  expect(await sendWebPush(sub,key,notification,'https://camp.example',async()=>new Response(null,{status:410}))).toBe(410);
 });
});
