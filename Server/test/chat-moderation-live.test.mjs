import {describe,it,expect} from 'vitest';
import {chatDatabase} from './helpers/chat-db.mjs';
import {handleChatAdmin} from '../src/chat-admin.ts';
import {listMessages,getRoomSyncCursor,listRoomMessageEvents} from '../chat/worker/src/data/messages.js';
describe('admin moderation and live membership projection',()=>{
 it.each(['public','private','dm'])('deletes %s content and notifies both room and Inbox connections, with durable replay',async kind=>{
  const db=await chatDatabase();try{
   const room=db.createRoom(kind),id=db.message(room),cursor=await getRoomSyncCursor(db.env.DB,room.id);
   const result=await handleChatAdmin(new Request(`https://camp.example/api/admin/chat/rooms/${room.id}/messages/${id}`,{method:'DELETE'}),db.env,{auth_method:'oidc'});
   expect(result.status).toBe(200);expect(await listMessages(db.env,room.id)).toEqual([]);
   expect(db.inbox).toHaveBeenCalledTimes(2);expect(db.room).toHaveBeenCalledOnce();
   expect(JSON.parse(db.inbox.mock.calls[0][1].body)).toMatchObject({type:'message_deleted',messageId:id,room});
   expect((await listRoomMessageEvents(db.env,room.id,cursor)).events).toContainEqual(expect.objectContaining({type:'message_deleted',messageId:id}));
  }finally{db.close();}
 });
 it('uses changed player names and filters revoked/expired identities immediately, including the selected room endpoint',async()=>{
  const db=await chatDatabase();try{
   const room=db.createRoom('private');
   db.sqlite.prepare("UPDATE identity_codes SET player_name='Alice updated' WHERE id='a'").run();
   db.sqlite.prepare("UPDATE identity_codes SET status='disabled' WHERE id='b'").run();
   const root=await handleChatAdmin(new Request('https://camp.example/api/admin/chat'),db.env,{auth_method:'oidc'});
   expect((await root.json()).rooms.find(x=>x.id===room.id).members).toBe('Alice updated');
   const detail=await handleChatAdmin(new Request(`https://camp.example/api/admin/chat/rooms/${room.id}/messages`),db.env,{auth_method:'oidc'});
   expect((await detail.json()).room.members).toBe('Alice updated');
   db.sqlite.prepare("UPDATE identity_codes SET expires_at=datetime('now','-1 second') WHERE id='a'").run();
   const expired=await handleChatAdmin(new Request('https://camp.example/api/admin/chat'),db.env,{auth_method:'oidc'});
   expect((await expired.json()).rooms.find(x=>x.id===room.id).members).toBeNull();
  }finally{db.close();}
 });
});
