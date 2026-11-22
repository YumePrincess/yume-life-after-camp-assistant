/* Notifications only: no fetch interception or application caching. */
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let notification;
    try { notification = event.data.json(); } catch { return; }
    if (!notification?.data || !['public','private','dm'].includes(notification.data.roomKind)
      || !Number.isSafeInteger(notification.data.roomId) || notification.data.roomId < 1) return;
    // Safari requires every received push to display a system notification.
    await self.registration.showNotification(notification.title, {
      body:notification.body, tag:notification.tag, data:notification.data, renotify:Boolean(notification.tag),
      icon:'/notification-icon.png', badge:'/notification-icon.png'
    });
  })());
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const {roomKind,roomId} = event.notification.data || {};
    if (!['public','private','dm'].includes(roomKind) || !Number.isSafeInteger(roomId) || roomId < 1) return;
    const url = new URL('/',self.location.origin);
    url.searchParams.set('chatRoom',`${roomKind}:${roomId}`);
    url.hash = 'chat';
    const windows = await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const existing = windows.find(client => new URL(client.url).origin === url.origin && new URL(client.url).pathname === '/');
    if (existing) {
      existing.postMessage({type:'camp-chat:open-room',room:{kind:roomKind,id:roomId}});
      await existing.focus();
    } else await self.clients.openWindow(url.href);
  })());
});
