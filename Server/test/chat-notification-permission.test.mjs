import {describe,it,expect,vi} from 'vitest';
vi.mock('../chat/frontend/src/capacitor-platform.ts',()=>({getNativeNotificationBridge:()=>null}));
vi.mock('../chat/frontend/src/i18n.js',()=>({t:key=>key}));
vi.mock('../chat/frontend/src/message-markdown.ts',()=>({messageMarkdownToPlainText:text=>text}));
vi.mock('../chat/frontend/src/web-push.js',()=>({createWebPush:vi.fn()}));
import {useBrowserNotifications} from '../chat/frontend/src/composables/useBrowserNotifications.js';
describe('notification permission gesture',()=>{
 it('requests browser permission synchronously within the original click gesture',async()=>{
  function Notification(){};Notification.permission='default';Notification.requestPermission=vi.fn(async()=>'granted');
  const notifications=useBrowserNotifications({browserWindow:{Notification},nativeNotifications:null,storage:{getItem:()=>null,setItem(){}}});
  const pending=notifications.toggleNotifications();
  expect(Notification.requestPermission).toHaveBeenCalledOnce();
  await pending;expect(notifications.notificationsEnabled.value).toBe(true);
 });
 it('does not ask for permission again when turning notifications off',async()=>{
  function Notification(){};Notification.permission='granted';Notification.requestPermission=vi.fn();
  const notifications=useBrowserNotifications({browserWindow:{Notification},nativeNotifications:null,storage:{getItem:()=>JSON.stringify({enabled:true}),setItem(){}}});
  await notifications.toggleNotifications();expect(Notification.requestPermission).not.toHaveBeenCalled();expect(notifications.notificationsEnabled.value).toBe(false);
 });
});
