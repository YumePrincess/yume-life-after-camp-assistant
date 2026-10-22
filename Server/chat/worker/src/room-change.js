import { listRoomMemberIds } from './data/unread.js';
import { notifyUserInbox } from './do-bridge.js';

// Inbox connections survive leaving the active conversation. Include the author,
// whose message may also be moderated while their room socket is disconnected.
export async function notifyRoomDeletion(env, room, messageId) {
  const ids = await listRoomMemberIds(env.DB, room.id);
  const results = await Promise.allSettled(ids.map(userId => notifyUserInbox(env, userId, {
    protocolVersion:1, type:'message_deleted', room:{kind:room.kind,id:Number(room.id)}, messageId:Number(messageId)
  }).then(response => { if (!response.ok) throw new Error('Inbox invalidation failed'); })));
  if (results.some(result => result.status === 'rejected')) console.warn('Room deletion inbox delivery failed');
}
