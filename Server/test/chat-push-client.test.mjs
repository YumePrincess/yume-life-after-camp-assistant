import {describe,it,expect,vi} from 'vitest';
vi.mock('../chat/frontend/src/api.js',()=>({default:{}}));
import {createWebPush,pageIsForeground} from '../chat/frontend/src/web-push.js';
function setup() {
 const values=new Map(),storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};
 const key=new Uint8Array(65).fill(3), subscription={options:{applicationServerKey:key.buffer},toJSON:()=>({endpoint:'https://web.push.apple.com/test'}),unsubscribe:vi.fn(async()=>{})};
 const manager={getSubscription:vi.fn(async()=>subscription),subscribe:vi.fn(async()=>subscription)};
 const registration={pushManager:manager};
 const navigator={language:'ja-JP',serviceWorker:{register:vi.fn(async()=>registration),ready:Promise.resolve(registration)}};
 const apiClient={pushKey:vi.fn(async()=>({publicKey:Buffer.from(key).toString('base64url')})),savePushSubscription:vi.fn(async()=>{}),removePushSubscription:vi.fn(async()=>{})};
 vi.stubGlobal('PushManager',function(){});vi.stubGlobal('document',{documentElement:{lang:'ja-JP'}});
 return {push:createWebPush({storage,navigator,apiClient}),apiClient,manager,subscription,navigator,values};
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
