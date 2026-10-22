import {describe,it,expect} from 'vitest';
import {chatDatabase} from './helpers/chat-db.mjs';
import {recallRoomMessage} from '../chat/worker/src/message-recall.js';
import {listMessages,getRoomSyncCursor,listRoomMessageEvents,softDeleteMessage} from '../chat/worker/src/data/messages.js';
import {countUnreadMessages} from '../chat/worker/src/data/unread.js';
import {attachConversationPreviews} from '../chat/worker/src/data/conversation-previews.js';
import {canAccessFile} from '../chat/worker/src/data/uploaded-files.js';
import {handleChatAdmin} from '../src/chat-admin.ts';
import {canRecallMessage} from '../chat/frontend/src/recall.js';
describe('120-second recall',()=>{
 it.each(['public','private','dm'])('retains the original %s record for admins while redacting message, preview, reply and attachment access',async kind=>{
  const db=await chatDatabase();try{
   const room=db.createRoom(kind),userId=db.users[0].id,other=db.users[1].id;
   const id=db.message(room,{content:'private original',attachmentKey:'test-'+kind});
   const reply=db.message(room,{senderId:other,content:'reply',replyId:id});
   db.sqlite.prepare('INSERT INTO channel_pins(channel_id,message_id,pinned_by) VALUES(?,?,?)').run(room.id,id,userId);
   const cursor=await getRoomSyncCursor(db.env.DB,room.id);
   const result=await recallRoomMessage(db.env,{userId},room,id);
   expect(result.message).toMatchObject({id,content:'',attachment:null,recalledAt:expect.any(String)});
   expect(db.sqlite.prepare('SELECT content,deleted_at,recalled_at FROM messages WHERE id=?').get(id)).toMatchObject({content:'private original',deleted_at:null,recalled_at:expect.any(String)});
   expect(db.inbox).toHaveBeenCalledTimes(2);expect(db.room).toHaveBeenCalledOnce();
   const visible=await listMessages(db.env,room.id);expect(visible.find(x=>x.id===id).content).toBe('');expect(visible.find(x=>x.id===reply).replyTo).toMatchObject({deleted:true});
   expect(await canAccessFile(db.env.DB,'test-'+kind,other)).toBe(false);
   expect(db.sqlite.prepare('SELECT count(*) AS count FROM channel_pins WHERE channel_id=?').get(room.id).count).toBe(0);
   const events=await listRoomMessageEvents(db.env,room.id,cursor);expect(events.events).toContainEqual(expect.objectContaining({type:'message',message:expect.objectContaining({id,recalledAt:expect.any(String),content:''})}));
   const response=await handleChatAdmin(new Request(`https://camp.example/api/admin/chat/rooms/${room.id}/messages`),db.env,{auth_method:'oidc'});
   expect((await response.json()).messages.find(x=>x.id===id)).toMatchObject({content:'private original',recalledAt:expect.any(String)});
   await recallRoomMessage(db.env,{userId},room,id); // idempotent retry
   await softDeleteMessage(db.env.DB,{channelId:room.id,messageId:id});
   expect((await listMessages(db.env,room.id)).some(x=>x.id===id)).toBe(false);
  }finally{db.close();}
 });
 it('rejects a different sender and expired messages, but accepts an own message just before the deadline',async()=>{
  const db=await chatDatabase();try{
   const room=db.createRoom('dm'),userId=db.users[0].id,other=db.users[1].id;
   const foreign=db.message(room,{senderId:other}),expired=db.message(room,{createdAt:new Date(Date.now()-121000).toISOString()});
   await expect(recallRoomMessage(db.env,{userId},room,foreign)).rejects.toMatchObject({status:403});
   await expect(recallRoomMessage(db.env,{userId},room,expired)).rejects.toMatchObject({status:409});
   const own=db.message(room,{createdAt:new Date(Date.now()-119000).toISOString()});
   await recallRoomMessage(db.env,{userId},room,own);
   expect(await countUnreadMessages(db.env.DB,{channelId:room.id,userId:other})).toBe(1); // expired original still unread; recalled message excluded
  }finally{db.close();}
 });
 it('redacts a recalled latest message from the conversation preview',async()=>{
  const db=await chatDatabase();try{const room=db.createRoom('private'),id=db.message(room,{content:'secret'});await recallRoomMessage(db.env,{userId:db.users[0].id},room,id);
   const [preview]=await attachConversationPreviews(db.env,[{...room,isMember:true}],db.users[1].id);
   expect(preview.lastMessage).toMatchObject({id,content:'',attachment:null,recalledAt:expect.any(String)});
  }finally{db.close();}
 });
 it('hides the menu action for non-owners, recalled messages and times beyond exactly 120 seconds',()=>{
  const now=Date.parse('2026-10-22T08:00:00Z'),message={sender:{kind:'local',id:1},createdAt:'2026-10-22 07:58:00'};
  expect(canRecallMessage(message,1,now)).toBe(true);expect(canRecallMessage(message,1,now+1)).toBe(false);
  expect(canRecallMessage(message,2,now)).toBe(false);expect(canRecallMessage({...message,recalledAt:'now'},1,now)).toBe(false);
  expect(canRecallMessage({...message,sender:{kind:'external',id:1}},1,now)).toBe(false);
 });
});
