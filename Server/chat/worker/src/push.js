import { buildPushPayload } from '@block65/webcrypto-web-push';

const KEY = 'web-push:v1:key';
const DEVICES = 'web-push:v1:devices';
export const deviceStoreKey = DEVICES;
function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export async function loadPushKey(storage) {
  let key = await storage.get(KEY);
  if (!key) {
    const pair = await crypto.subtle.generateKey({name:'ECDSA', namedCurve:'P-256'}, true, ['sign','verify']);
    const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    key = { publicKey: base64url(await crypto.subtle.exportKey('raw', pair.publicKey)), privateKey: jwk.d };
    await storage.put(KEY, key);
  }
  return key;
}
export function validSubscription(value) {
  try {
    const url = new URL(value.endpoint);
    const host = url.hostname;
    const allowed = host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com'
      || host === 'push.services.mozilla.com' || host.endsWith('.push.apple.com')
      || host.endsWith('.notify.windows.com');
    const decode = raw => Uint8Array.from(atob(raw.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
    const key = decode(value.keys.p256dh), auth = decode(value.keys.auth);
    return allowed && url.protocol === 'https:' && !url.username && !url.password && !url.port
      && value.endpoint.length <= 4096 && key.length === 65 && key[0] === 4 && auth.length === 16;
  } catch { return false; }
}
const messages = {
  'zh-TW': ['全體成員群','互動中心','收到一則新訊息'],
  'zh-Hant': ['全體成員群','互動中心','收到一則新訊息'],
  'zh': ['全体成员群','互动中心','收到一条新消息'],
  'ja': ['全体メンバーグループ','交流センター','新しいメッセージが届きました'],
  'en': ['All members','Chat','New message received'],
  'fr': ['Tous les membres','Discussion','Nouveau message reçu'],
};
export function pushNotification(event, language) {
  const labels = messages[language] || messages[String(language || '').split('-')[0]] || messages.en;
  const room = event.room;
  const title = room.kind !== 'dm' && (room.isGeneral || room.name === 'general') ? labels[0] : room.name || labels[1];
  // Keep private message content off the lock screen, matching the browser notification default.
  return {title, body:labels[2], tag:`edgechat:${room.kind}:${Number(room.id)}`,
    data:{roomKind:room.kind, roomId:Number(room.id), messageId:event.messageId}};
}
export async function sendWebPush(subscription, key, notification, subject, fetcher = fetch) {
  const init = await buildPushPayload({data:JSON.stringify(notification), options:{ttl:3600}}, subscription, {...key, subject});
  const response = await fetcher(subscription.endpoint, {...init, redirect:'error', signal:AbortSignal.timeout(10000)});
  return response.status;
}
