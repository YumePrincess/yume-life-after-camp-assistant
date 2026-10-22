import {describe,it,expect,vi} from 'vitest';
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
  const notification=pushNotification({room:{kind:'channel',id:1,name:'general'},messageId:55},'ja-JP');
  expect(notification.title).toBe('全体メンバーグループ');
  expect(await sendWebPush(sub,key,notification,'https://camp.example',fetcher)).toBe(201);
  const [url,init]=fetcher.mock.calls[0];
  expect(url).toBe(sub.endpoint);
  const headers=new Headers(init.headers);
  expect(headers.get('Content-Encoding')).toBe('aes128gcm');
  expect(headers.get('Authorization')).toMatch(/^vapid t=.+, k=.+/);
  expect(headers.get('TTL')).toBe('3600');
  expect(Buffer.from(init.body).includes(Buffer.from(notification.title))).toBe(false);
 });
 it('rejects non-push hosts, redirects through credentials, insecure URLs and invalid encryption keys',async()=>{
  const sub=await subscription();
  for(const endpoint of ['http://web.push.apple.com/x','https://localhost/x','https://web.push.apple.com.evil.example/x','https://user:secret@web.push.apple.com/x','https://web.push.apple.com:8443/x']) expect(validSubscription({...sub,endpoint})).toBe(false);
  expect(validSubscription({...sub,keys:{...sub.keys,auth:'broken'}})).toBe(false);
 });
});
