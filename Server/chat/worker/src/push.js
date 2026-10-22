import { notificationContent } from '../../shared/notification-content.js';
import { notificationTranslator } from '../../shared/notification-locales.js';
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
export function pushNotification(event, language) {
  const content = notificationContent(event,notificationTranslator(language));
  return {title:content.title, body:content.body, tag:`edgechat:${event.room.kind}:${Number(event.room.id)}`,
    data:{roomKind:event.room.kind, roomId:Number(event.room.id), messageId:event.messageId}};
}
export async function sendWebPush(subscription, key, notification, subject, fetcher = fetch) {
  const init = await buildPushPayload({data:JSON.stringify(notification), options:{ttl:3600,urgency:'high'}}, subscription, {...key, subject});
  const response = await fetcher(subscription.endpoint, {...init, redirect:'error', signal:AbortSignal.timeout(10000)});
  if (response.status !== 404 && response.status !== 410 && !response.ok) {
    const failure = new Error('Push service rejected notification');
    failure.status = response.status;
    throw failure;
  }
  return response.status;
}
