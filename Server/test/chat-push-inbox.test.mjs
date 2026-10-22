import {describe,it,expect,vi,beforeEach} from 'vitest';
const mocks=vi.hoisted(()=>({auth:vi.fn(),send:vi.fn()}));
vi.mock('../chat/worker/src/session.js',()=>({validateSession:mocks.auth}));
vi.mock('../chat/worker/src/push.js',async importOriginal=>({...await importOriginal(),sendWebPush:mocks.send}));
import {UserInbox} from '../chat/worker/src/do/UserInbox.js';
function setup(){
 const devices={phone:{userId:1,token:'valid',updated:1,mutedRooms:[],language:'en',subject:'https://camp.example',subscription:{endpoint:'https://web.push.apple.com/test'}}};
 const data=new Map([['web-push:v1:devices',devices],['web-push:v1:key',{publicKey:'test',privateKey:'private'}]]);
 const storage={get:vi.fn(async key=>structuredClone(data.get(key))),put:vi.fn(async(k,v)=>data.set(k,structuredClone(v))),transaction:async fn=>fn(storage)};
 const inbox=new UserInbox({storage,getWebSockets:()=>[],blockConcurrencyWhile:fn=>fn()},{});
 return {inbox,data,devices};
}
const event={type:'room_message',room:{kind:'channel',id:1,name:'general'},messageId:50};
beforeEach(()=>{mocks.auth.mockReset().mockResolvedValue({ok:true,session:{userId:1}});mocks.send.mockReset().mockResolvedValue(201);});
describe('per-device background chat delivery',()=>{
 it('delivers while offline and preserves subscriptions on transient failures',async()=>{
  const {inbox,data}=setup();mocks.send.mockRejectedValue(new Error('offline'));
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  await inbox.push(event);expect(mocks.send).toHaveBeenCalledOnce();expect(data.get('web-push:v1:devices').phone).toBeTruthy();warn.mockRestore();
 });
 it('does not push to a foreground device but continues to push to another device',async()=>{
  const {inbox,data}=setup();const devices=data.get('web-push:v1:devices');devices.desktop={...devices.phone};
  inbox.connections.add({deserializeAttachment:()=>({deviceId:'desktop',foreground:true,presenceAt:Date.now()})});
  await inbox.push(event);expect(mocks.send).toHaveBeenCalledOnce();
 });
 it('does not keep suppressing pushes after foreground presence expires',async()=>{
  const {inbox}=setup();inbox.connections.add({deserializeAttachment:()=>({deviceId:'phone',foreground:true,presenceAt:Date.now()-46000})});
  await inbox.push(event);expect(mocks.send).toHaveBeenCalledOnce();
 });
 it('honors room mute, with mention and reply exceptions',async()=>{
  const {inbox,data}=setup();data.get('web-push:v1:devices').phone.mutedRooms=['channel:1'];
  await inbox.push(event);expect(mocks.send).not.toHaveBeenCalled();
  await inbox.push({...event,mentionsMe:true});await inbox.push({...event,replyToMe:true});expect(mocks.send).toHaveBeenCalledTimes(2);
 });
 it('removes revoked sessions and expired endpoints',async()=>{
  const first=setup();mocks.auth.mockResolvedValue({ok:false});await first.inbox.push(event);expect(mocks.send).not.toHaveBeenCalled();expect(first.data.get('web-push:v1:devices')).toEqual({});
  mocks.auth.mockResolvedValue({ok:true,session:{userId:1}});mocks.send.mockResolvedValue(410);
  const second=setup();await second.inbox.push(event);expect(second.data.get('web-push:v1:devices')).toEqual({});
 });
});
