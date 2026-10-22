import {describe,it,expect,vi} from 'vitest';
vi.mock('../chat/frontend/src/api.js',()=>({default:{}}));
import {createWebPush,pageIsForeground,notificationBrowserWindow} from '../chat/frontend/src/web-push.js';
function setup() {
 const values=new Map(),storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};
 const key=new Uint8Array(65).fill(3), subscription={options:{applicationServerKey:key.buffer},toJSON:()=>({endpoint:'https://web.push.apple.com/test'}),unsubscribe:vi.fn(async()=>{})};
 const manager={getSubscription:vi.fn(async()=>subscription),subscribe:vi.fn(async()=>subscription)};
 const registration={active:{state:"activated"},pushManager:manager};
 const navigator={language:'ja-JP',serviceWorker:{register:vi.fn(async()=>registration),getRegistration:vi.fn(async()=>registration),ready:Promise.resolve(registration)}};
 const apiClient={pushKey:vi.fn(async()=>({publicKey:Buffer.from(key).toString('base64url')})),savePushSubscription:vi.fn(async()=>{}),removePushSubscription:vi.fn(async()=>{})};
 vi.stubGlobal('PushManager',function(){});vi.stubGlobal('document',{documentElement:{lang:'ja-JP'}});
 return {push:createWebPush({storage,navigator,apiClient}),apiClient,manager,subscription,navigator,values,registration};
}
describe('browser push subscription lifecycle',()=>{
 it('reuses an existing subscription and sends muted rooms and language',async()=>{
  const ui=setup();await ui.push.sync(true,['public:4']);
  expect(ui.manager.subscribe).not.toHaveBeenCalled();expect(ui.push.subscribed).toBe(true);
  expect(ui.apiClient.savePushSubscription).toHaveBeenCalledWith(expect.objectContaining({mutedRooms:['public:4'],language:'ja-JP'}));
  vi.unstubAllGlobals();
 });
 it('serializes an enable followed immediately by disable and unsubscribes server and device',async()=>{
  const ui=setup();const first=ui.push.sync(true,[]),second=ui.push.sync(false,[]);await Promise.all([first,second]);
  expect(ui.push.subscribed).toBe(false);expect(ui.apiClient.removePushSubscription).toHaveBeenCalledOnce();expect(ui.subscription.unsubscribe).toHaveBeenCalledOnce();vi.unstubAllGlobals();
 });
 it('replaces a subscription belonging to a previous account VAPID key',async()=>{
  const ui=setup();ui.subscription.options.applicationServerKey=new Uint8Array(65).fill(4).buffer;await ui.push.sync(true,[]);
  expect(ui.subscription.unsubscribe).toHaveBeenCalledOnce();expect(ui.manager.subscribe).toHaveBeenCalledWith(expect.objectContaining({userVisibleOnly:true}));vi.unstubAllGlobals();
 });
});

describe('foreground push suppression',()=>{
 it('treats a visible but unfocused browser as background, including an embedded chat',()=>{
  const page={visibilityState:'visible',hasFocus:()=>false};vi.stubGlobal('window',{top:{document:page}});
  expect(pageIsForeground()).toBe(false);
  page.hasFocus=()=>true;expect(pageIsForeground()).toBe(true);
  page.visibilityState='hidden';expect(pageIsForeground()).toBe(false);
  vi.unstubAllGlobals();
 });
});

describe('subscription activation and recovery',()=>{
 it('uses the same-origin top-level browser APIs from a hidden chat frame',()=>{
  const top={document:{},navigator:{serviceWorker:{}}};
  expect(notificationBrowserWindow({top})).toBe(top);
  const isolated={get top(){throw new Error('cross origin');}};
  expect(notificationBrowserWindow(isolated)).toBe(isolated);
 });
 it('waits for the registered root worker to activate, without waiting on another scope’s ready promise',async()=>{
  const ui=setup();let changed;
  delete ui.registration.active;
  const worker={state:'installing',addEventListener:vi.fn((_name,listener)=>changed=listener),removeEventListener:vi.fn()};
  ui.registration.installing=worker;
  ui.navigator.serviceWorker.ready=new Promise(()=>{});
  const pending=ui.push.sync(true,[]);
  await vi.waitFor(()=>expect(changed).toBeTypeOf('function'));
  expect(ui.apiClient.savePushSubscription).not.toHaveBeenCalled();
  worker.state='activated';changed();await pending;
  expect(ui.push.subscribed).toBe(true);expect(worker.removeEventListener).toHaveBeenCalledOnce();vi.unstubAllGlobals();
 });
 it('does not claim system delivery until the subscription is saved, and retries after failure',async()=>{
  const ui=setup();ui.apiClient.savePushSubscription.mockRejectedValueOnce(new Error('offline'));
  await expect(ui.push.sync(true,[])).rejects.toThrow('offline');expect(ui.push.subscribed).toBe(false);
  await ui.push.sync(true,[]);expect(ui.push.subscribed).toBe(true);vi.unstubAllGlobals();
 });
});

it('can disable system delivery even when registering a Service Worker would fail',async()=>{
 const ui=setup();ui.navigator.serviceWorker.register.mockRejectedValue(new Error('offline'));
 await ui.push.sync(false,[]);
 expect(ui.apiClient.removePushSubscription).toHaveBeenCalledOnce();expect(ui.subscription.unsubscribe).toHaveBeenCalledOnce();
 expect(ui.navigator.serviceWorker.register).not.toHaveBeenCalled();vi.unstubAllGlobals();
});
