import api from './api.js';

export function pageIsForeground() {
  try { return window.top.document.visibilityState === 'visible'; }
  catch { return document.visibilityState === 'visible'; }
}
function decodeKey(value) {
  return Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')), character => character.charCodeAt(0));
}
export function createWebPush({storage = localStorage, navigator = globalThis.navigator, apiClient = api} = {}) {
  let subscribed = false;
  let sequence = Promise.resolve();
  const deviceId = storage.getItem('camp-chat:push-device') || crypto.randomUUID();
  storage.setItem('camp-chat:push-device',deviceId);
  async function update(enabled, mutedRooms) {
    if (!navigator?.serviceWorker || !globalThis.PushManager) return;
    const registration = await navigator.serviceWorker.register('/sw.js',{scope:'/',updateViaCache:'none'});
    await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!enabled) {
      await apiClient.removePushSubscription(deviceId);
      if (subscription) await subscription.unsubscribe();
      subscribed = false;
      return;
    }
    const {publicKey} = await apiClient.pushKey();
    const key = decodeKey(publicKey);
    const existing = subscription?.options?.applicationServerKey;
    if (subscription && (!existing || String(new Uint8Array(existing)) !== String(key))) {
      await subscription.unsubscribe(); subscription = null;
    }
    if (!subscription) subscription = await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
    await apiClient.savePushSubscription({deviceId, subscription:subscription.toJSON(), mutedRooms, language:document.documentElement.lang || navigator.language});
    subscribed = true;
  }
  return {
    get subscribed() { return subscribed; },
    sync(enabled, mutedRooms) {
      // Serialize enable/disable and mute updates to preserve the last user action.
      sequence = sequence.catch(()=>{}).then(()=>update(enabled,[...mutedRooms]));
      return sequence;
    }
  };
}
