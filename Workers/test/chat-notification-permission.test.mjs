import {describe,it,expect,vi} from 'vitest';
vi.mock('../chat/frontend/src/capacitor-platform.ts',()=>({getNativeNotificationBridge:()=>null}));
vi.mock('../chat/frontend/src/i18n.js',()=>({t:key=>key}));
vi.mock('../chat/frontend/src/message-markdown.ts',()=>({messageMarkdownToPlainText:text=>text}));
vi.mock('../chat/frontend/src/web-push.js',async original=>({...await original(),createWebPush:vi.fn()}));
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

describe('system push connection state',()=>{
 it('retains notification intent after a failed subscription and lets Retry reconnect without another permission prompt',async()=>{
  const {createWebPush}=await import('../chat/frontend/src/web-push.js');
  const sync=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  createWebPush.mockReturnValue({subscribed:false,sync});
  function Notification(){};Notification.permission='granted';Notification.requestPermission=vi.fn();
  const failure=vi.fn();
  const notifications=useBrowserNotifications({browserWindow:{Notification,navigator:{serviceWorker:{}}},nativeNotifications:null,onError:failure,
   storage:{getItem:()=>JSON.stringify({enabled:true,mutedRooms:[]}),setItem(){}}});
  await vi.waitFor(()=>expect(notifications.pushState.value).toBe('error'));
  expect(notifications.notificationsEnabled.value).toBe(true);expect(notifications.notificationActionLabel.value).toBe('common.retry');
  expect(failure).toHaveBeenCalledOnce();
  await notifications.toggleNotifications();
  expect(sync).toHaveBeenLastCalledWith(true,[]);expect(notifications.pushState.value).toBe('ready');
  expect(notifications.notificationsEnabled.value).toBe(true);expect(Notification.requestPermission).not.toHaveBeenCalled();
 });
 it('requests permission from the top-level Home Screen context when chat is embedded',async()=>{
  function Notification(){};Notification.permission='default';Notification.requestPermission=vi.fn(async()=>'granted');
  const parent={document:{},Notification};
  const notifications=useBrowserNotifications({browserWindow:{top:parent},nativeNotifications:null,storage:{getItem:()=>null,setItem(){}}});
  const pending=notifications.toggleNotifications();expect(Notification.requestPermission).toHaveBeenCalledOnce();await pending;
  expect(notifications.notificationsEnabled.value).toBe(true);
 });
});
