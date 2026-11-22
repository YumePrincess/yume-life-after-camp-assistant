import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {describe,it,expect,vi} from 'vitest';
const source=readFileSync(new URL('../public/sw.js',import.meta.url),'utf8');
function setup(windows=[]) {
 const handlers={}, self={location:{origin:'https://camp.example'},addEventListener:(name,fn)=>handlers[name]=fn,
  registration:{showNotification:vi.fn(async()=>{})},clients:{matchAll:vi.fn(async()=>windows),openWindow:vi.fn(async()=>{})}};
 runInNewContext(source,{self,URL});
 return {self,async run(name,event){let pending;handlers[name]({...event,waitUntil:p=>pending=p});await pending;}};
}
describe('notification Service Worker',()=>{
 it('always displays received pushes, including foreground Safari, without silent delivery',async()=>{
  const ui=setup([{url:'https://camp.example/',visibilityState:'visible'}]);
  await ui.run('push',{data:{json:()=>({title:'Chat',body:'New message',tag:'room',data:{roomKind:'public',roomId:2,messageId:3}})}});
  expect(ui.self.registration.showNotification).toHaveBeenCalledWith('Chat',expect.objectContaining({data:{roomKind:'public',roomId:2,messageId:3},renotify:true}));
 });
 it('focuses an existing homepage and opens the target room without navigation',async()=>{
  const client={url:'https://camp.example/#vote',focus:vi.fn(async()=>{}),postMessage:vi.fn()};const ui=setup([client]);
  const close=vi.fn();await ui.run('notificationclick',{notification:{close,data:{roomKind:'dm',roomId:9}}});
  expect(close).toHaveBeenCalledOnce();expect(client.focus).toHaveBeenCalledOnce();expect(client.postMessage).toHaveBeenCalledWith({type:'camp-chat:open-room',room:{kind:'dm',id:9}});expect(ui.self.clients.openWindow).not.toHaveBeenCalled();
 });
 it('opens a closed application at the homepage hash route and rejects malformed targets',async()=>{
  const ui=setup();await ui.run('notificationclick',{notification:{close(){},data:{roomKind:'public',roomId:7}}});
  expect(ui.self.clients.openWindow).toHaveBeenCalledWith('https://camp.example/?chatRoom=public%3A7#chat');
  await ui.run('push',{data:{json:()=>({title:'bad',data:{roomKind:'public',roomId:'https://evil.example'}})}});
  expect(ui.self.registration.showNotification).not.toHaveBeenCalled();
 });
});
