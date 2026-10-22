import { ApiError } from './errors.js';
import { authorizeRoom } from './room-access.js';
import { getMessageById } from './data/messages.js';
import { listRoomMemberIds } from './data/unread.js';
import { createInternalHeaders } from './verified-identity.js';
import { getChannelRoomStub, notifyUserInbox } from './do-bridge.js';
import { cleanupR2Keys } from './gc.js';

export async function recallRoomMessage(env, principal, room, messageId) {
  const access = await authorizeRoom(env.DB, principal, room.kind, Number(room.id));
  if (!access.ok) throw new ApiError('无权访问该会话',403);
  const target = await env.DB.prepare('SELECT sender_id,sender_kind,recalled_at,attachment_key FROM messages WHERE id=? AND channel_id=? AND deleted_at IS NULL')
    .bind(Number(messageId),Number(room.id)).first();
  if (!target) throw new ApiError('消息不存在或已被删除',404);
  if (target.sender_kind !== 'local' || Number(target.sender_id) !== Number(principal.userId)) throw new ApiError('只能撤回本人发送的消息',403);
  if (!target.recalled_at) {
    const result = await env.DB.prepare(`UPDATE messages SET recalled_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=? AND channel_id=? AND sender_id=? AND sender_kind='local' AND deleted_at IS NULL AND recalled_at IS NULL
      AND julianday(created_at) BETWEEN julianday('now','-120 seconds') AND julianday('now')`)
      .bind(Number(messageId),Number(room.id),Number(principal.userId)).run();
    if (!result.meta.changes) {
      const current=await env.DB.prepare('SELECT recalled_at FROM messages WHERE id=? AND channel_id=? AND deleted_at IS NULL').bind(Number(messageId),Number(room.id)).first();
      if (!current?.recalled_at) throw new ApiError('撤回时限已过（120秒）',409);
    }
  }
  if (target.attachment_key) await cleanupR2Keys(env, [target.attachment_key]);
  const message = await getMessageById(env,Number(messageId));
  if (!message) throw new ApiError('消息不存在或已被删除',404);
  const packet = {protocolVersion:1,type:'message_recalled',room:{kind:room.kind,id:Number(room.id)},message};
  const members = await listRoomMemberIds(env.DB,room.id);
  const tasks = members.map(id=>notifyUserInbox(env,id,packet).then(response=>{if(!response.ok) throw new Error('Recall inbox delivery failed');}));
  tasks.push(getChannelRoomStub(env,room.kind,room.id).fetch('https://cfchat.internal/moderation-event',{
    method:'POST',headers:createInternalHeaders({'Content-Type':'application/json'}),body:JSON.stringify({type:'message_recalled',messageId:Number(messageId)})
  }).then(response=>{if(!response.ok) throw new Error('Recall room delivery failed');}));
  const results = await Promise.allSettled(tasks);
  if (results.some(result=>result.status==='rejected')) console.warn('Message recall realtime delivery failed');
  return {message};
}
