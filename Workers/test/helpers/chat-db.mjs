import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {vi} from 'vitest';
import {syncIdentityChatUsers} from '../../chat/worker/src/session.js';
export async function chatDatabase() {
 const sqlite=new DatabaseSync(':memory:');
 const root=new URL('../../migrations/',import.meta.url);
 for(const name of readdirSync(root).filter(x=>x.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(name,root),'utf8'));
 const DB={prepare(sql){let args=[];return {bind(...values){args=values;return this;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async first(){return sqlite.prepare(sql).get(...args)||null;},async run(){const result=sqlite.prepare(sql).run(...args);return {meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)}};}};},async batch(statements){return Promise.all(statements.map(statement=>statement.run()));}};
 for(const [id,name] of [['a','Alice'],['b','Bob']]) sqlite.prepare(`INSERT INTO identity_codes(id,code_hash,code_encrypted,player_name,created_by,created_at,updated_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).run(id,id,'test',name,'test');
 await syncIdentityChatUsers({DB});
 const users=sqlite.prepare('SELECT id,display_name FROM users ORDER BY id').all();
 const inbox=vi.fn(async()=>Response.json({ok:true})), room=vi.fn(async()=>Response.json({ok:true}));
 const env={DB,USER_INBOX:{idFromName:x=>x,get:()=>({fetch:inbox})},CHANNEL_ROOM:{idFromName:x=>x,get:()=>({fetch:room})}};
 function createRoom(kind){
  const result=sqlite.prepare('INSERT INTO channels(name,kind) VALUES(?,?)').run(kind+'-'+Math.random(),kind);
  const id=Number(result.lastInsertRowid);
  for(const user of users) sqlite.prepare('INSERT INTO channel_members(channel_id,user_id,role) VALUES(?,?,?)').run(id,user.id,user.id===users[0].id?'owner':'member');
  return {id,kind};
 }
 function message(room,{senderId=users[0].id,content='original body',createdAt=new Date().toISOString(),attachmentKey=null,replyId=null}={}){
  if(attachmentKey) sqlite.prepare(`INSERT INTO uploaded_files(object_key,owner_user_id,filename,content_type,size) VALUES(?,?,?,?,?)`).run(attachmentKey,senderId,'test.png','image/png',10);
  return Number(sqlite.prepare('INSERT INTO messages(channel_id,sender_id,content,created_at,attachment_key,attachment_name,attachment_type,reply_to_message_id) VALUES(?,?,?,?,?,?,?,?)').run(room.id,senderId,content,createdAt,attachmentKey,attachmentKey?'test.png':null,attachmentKey?'image/png':null,replyId).lastInsertRowid);
 }
 return {sqlite,env,users,inbox,room,createRoom,message,close:()=>sqlite.close()};
}
