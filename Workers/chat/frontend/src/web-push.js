import api from './api.js';

export function pageIsForeground() {
  try { const page=window.top.document; return page.visibilityState === 'visible' && page.hasFocus(); }
  catch { return document.visibilityState === 'visible' && document.hasFocus(); }
}
export function notificationBrowserWindow(browserWindow = globalThis.window) {
  try { if (browserWindow?.top?.document) return browserWindow.top; } catch { /* Cross-origin host. */ }
  return browserWindow;
}
function activeRegistration(registration) {
  if (registration.active) return Promise.resolve(registration);
  const worker = registration.installing || registration.waiting;
  if (!worker) return Promise.reject(new Error('push_registration_failed'));
  return new Promise((resolve,reject) => {
    const timer = setTimeout(() => finish(new Error('push_registration_failed')), 10000);
    function finish(error) {
      clearTimeout(timer); worker.removeEventListener('statechange', changed);
      if (error) reject(error); else resolve(registration);
    }
    function changed() {
      if (worker.state === 'activated') finish();
      else if (worker.state === 'redundant') finish(new Error('push_registration_failed'));
    }
    worker.addEventListener('statechange', changed); changed();
  });
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
    if (!enabled) {
      subscribed = false;
      await apiClient.removePushSubscription(deviceId);
      const registration = await navigator?.serviceWorker?.getRegistration?.('/');
      const subscription = await registration?.pushManager?.getSubscription();
      if (subscription) await subscription.unsubscribe();
      return;
    }
    if (!navigator?.serviceWorker) throw new Error('push_unavailable');
    const registration = await activeRegistration(await navigator.serviceWorker.register('/sw.js',{scope:'/',updateViaCache:'none'}));
    if (!registration.pushManager) throw new Error('push_unavailable');
    let subscription = await registration.pushManager.getSubscription();
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
      sequence = sequence.catch(()=>{}).then(()=>update(enabled,[...mutedRooms])).catch(error=>{subscribed=false;throw error;});
      return sequence;
    }
  };
}
