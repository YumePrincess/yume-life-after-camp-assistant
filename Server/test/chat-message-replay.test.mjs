import {describe,it,expect,vi} from 'vitest';
import {ref,nextTick} from 'vue';
vi.mock('../chat/frontend/src/api.js',()=>({default:{}}));
vi.mock('../chat/frontend/src/ws.js',()=>({connectRoomSocket:vi.fn()}));
vi.mock('../chat/frontend/src/i18n.js',()=>({t:key=>key,localizeServerError:text=>text}));
import {useChatRoom} from '../chat/frontend/src/composables/useChatRoom.js';
const message=(id,extra={})=>({id,content:'text '+id,sender:{kind:'local',id:2},createdAt:'2026-10-22T00:00:00Z',...extra});
function setup() {
 const activeRoom=ref({kind:'public',id:1}), sockets=[];
 const roomApi={getMessages:vi.fn(async()=>({messages:[message(1),message(2)],pinnedMessage:message(2),syncCursor:2})),syncMessages:vi.fn(async(_kind,_id,cursor)=>({events:[],nextCursor:cursor,hasMore:false})),markRoomRead:vi.fn(async()=>{})};
 const chat=useChatRoom({activeRoom,session:ref({userId:1}),error:ref(''),roomApi,openRoomConnection:handlers=>{
  const socket={readyState:0,close:vi.fn(),send:vi.fn()};sockets.push({socket,handlers});return socket;
 }});
 function open(index=sockets.length-1){const {socket,handlers}=sockets[index];socket.readyState=1;handlers.onStatus({status:'open',socket});return {socket,handlers};}
 return {chat,roomApi,activeRoom,sockets,open};
}
describe('in-place message replay',()=>{
 it('removes missed deletions and clears pins after reconnect, preserving the draft and scroll position',async()=>{
  const ui=setup();await ui.chat.activateRoom();ui.open();await ui.chat.syncMessages();await nextTick();
  ui.chat.composerText.value='unsent draft';ui.chat.messagesEl.value={scrollTop:74,scrollHeight:500};
  ui.chat.pauseRoom();
  ui.roomApi.syncMessages.mockResolvedValue({events:[{type:'message_deleted',messageId:2},{type:'message',message:message(3)}],nextCursor:4,hasMore:false});
  ui.chat.connectSocket();ui.open();await ui.chat.syncMessages();await nextTick();
  expect(ui.chat.messages.value.map(x=>x.id)).toEqual([1,3]);expect(ui.chat.pinnedMessage.value).toBeNull();
  expect(ui.chat.composerText.value).toBe('unsent draft');expect(ui.chat.messagesEl.value.scrollTop).toBe(74);ui.chat.disconnectSocket();
 });
 it('does not resurrect a deleted or recalled body from a late initial HTTP snapshot',async()=>{
  const ui=setup();let finish;ui.roomApi.getMessages.mockImplementation(()=>new Promise(resolve=>finish=resolve));
  const pending=ui.chat.activateRoom();const {socket,handlers}=ui.open();
  handlers.onMessage(JSON.stringify({type:'message_deleted',messageId:2}),socket);
  const recalled=message(1,{content:'',recalledAt:'2026-10-22T00:01:00Z'});
  handlers.onMessage(JSON.stringify({type:'message_recalled',message:recalled}),socket);
  finish({messages:[message(1),message(2)],pinnedMessage:message(2),syncCursor:2});await pending;await ui.chat.syncMessages();
  expect(ui.chat.messages.value).toHaveLength(1);expect(ui.chat.messages.value[0]).toMatchObject({id:1,content:'',attachment:null,recalledAt:expect.any(String)});
  expect(ui.chat.pinnedMessage.value).toBeNull();ui.chat.disconnectSocket();
 });
});
