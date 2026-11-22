import { recallRoomMessage } from '../message-recall.js';
import { listMessages, getRoomSyncCursor, listRoomMessageEvents } from '../data/messages.js';
import { getPinnedMessage } from '../data/pins.js';
import { markRoomRead } from '../data/unread.js';
import { authorizeRoom, isRoomKind } from '../room-access.js';
import { errorResponse, parseJsonRequest, sanitizeLimit } from '../utils.js';

export function registerMessageRoutes(app) {
  app.post('/api/messages/recall', async c => {
    const payload = await parseJsonRequest(c.req.raw);
    if (!isRoomKind(payload.kind) || !Number.isSafeInteger(Number(payload.roomId)) || Number(payload.roomId)<1 || !Number.isSafeInteger(Number(payload.messageId)) || Number(payload.messageId)<1) return errorResponse('参数无效');
    return c.json(await recallRoomMessage(c.env,c.get('session'),{kind:payload.kind,id:Number(payload.roomId)},Number(payload.messageId)));
  });
  app.get('/api/messages/sync', async c => {
    const kind=c.req.query('kind'), roomId=Number(c.req.query('roomId')), after=Number(c.req.query('after'));
    if (!isRoomKind(kind) || !Number.isSafeInteger(roomId) || roomId < 1 || !Number.isSafeInteger(after) || after < 0) return errorResponse('参数无效');
    const access=await authorizeRoom(c.env.DB,c.get('session'),kind,roomId);
    if (!access.ok) return errorResponse('无权访问该会话',403);
    try { return c.json(await listRoomMessageEvents(c.env,roomId,after)); }
    catch (error) { if (error.code === 'sync_cursor_expired') return c.json({error:'sync_cursor_expired'},409); throw error; }
  });
  app.get('/api/messages', async (c) => {
    const session = c.get('session');
    const kind = c.req.query('kind');
    const roomId = Number(c.req.query('roomId'));
    const before = c.req.query('before');
    const limit = sanitizeLimit(c.req.query('limit'));

    if (!isRoomKind(kind) || !Number.isInteger(roomId) || roomId <= 0) {
      return errorResponse('参数无效');
    }

    const access = await authorizeRoom(c.env.DB, session, kind, roomId);

    if (!access.ok) {
      return errorResponse('无权访问该会话', 403);
    }

    const syncCursor = await getRoomSyncCursor(c.env.DB, roomId);
    const [messages, pinnedMessage] = await Promise.all([
      listMessages(c.env, roomId, before, limit),
      getPinnedMessage(c.env, roomId)
    ]);
    await markRoomRead(c.env.DB, {
      channelId: roomId,
      userId: session.userId
    });

    return c.json({
      room: {
        id: Number(access.room.id),
        kind: access.room.kind,
        name: access.room.name,
        description: access.room.description
      },
      messages,
      syncCursor,
      pinnedMessage
    });
  });

  app.post('/api/messages/read', async (c) => {
    const session = c.get('session');
    const payload = await parseJsonRequest(c.req.raw);
    const kind = String(payload.kind || '');
    const roomId = Number(payload.roomId);
    const messageId = payload.messageId === undefined ? null : Number(payload.messageId);

    if (
      !isRoomKind(kind) ||
      !Number.isInteger(roomId) ||
      roomId <= 0 ||
      (messageId !== null && (!Number.isInteger(messageId) || messageId <= 0))
    ) {
      return errorResponse('参数无效');
    }

    const access = await authorizeRoom(c.env.DB, session, kind, roomId);

    if (!access.ok) {
      return errorResponse('无权访问该会话', 403);
    }

    const lastReadMessageId = await markRoomRead(c.env.DB, {
      channelId: roomId,
      userId: session.userId,
      messageId
    });

    return c.json({ ok: true, lastReadMessageId });
  });
}
