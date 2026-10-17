import { bodyLimit } from 'hono/body-limit';
import { Hono } from 'hono';
import { authMiddleware } from './middleware.js';
import { listVisibleChannels } from './data/channels.js';
import { listUserDms } from './data/dm-queries.js';
import { ensureGeneralChannelMembership } from './data/general-channel.js';
import { listActiveUsers, getUserProfile } from './data/users.js';
import { registerChannelRoutes } from './api/channels.js';
import { registerContactRoutes } from './api/contacts.ts';
import { registerDmRoutes } from './api/dm.js';
import { registerMessageRoutes } from './api/messages.js';
import { registerUploadRoutes } from './api/upload.js';
import { registerUserBlockRoutes } from './api/user-blocks.ts';
import { forwardRoomConnection, forwardInboxConnection } from './do-bridge.js';
import { syncIdentityChatUsers } from './session.js';
import { ApiError } from './errors.js';

const app = new Hono();
app.use('/api/admin/*', (c)=>c.json({error:'接口不存在'},404));
app.use('/api/*', authMiddleware);
app.use('/api/*', (c,next)=>bodyLimit({maxSize:c.req.path==='/api/upload'?Number(c.env.MAX_FILE_SIZE)+1048576:65536,onError:(c)=>c.json({error:'请求体过大'},413)})(c,next));
app.get('/api/site', (c) => c.json({ site: { siteName: '互动中心', siteIconUrl: '' } }));
app.get('/api/auth/session', (c) => {
 const { token, ...session } = c.get('session');
 return c.json({ session });
});
app.get('/api/users', async (c) => c.json({ users: await listActiveUsers(c.env.DB,c.get('session').userId) }));
app.get('/api/users/:id/profile', async (c) => {
 const profile = await getUserProfile(c.env.DB,Number(c.req.param('id')));
 return profile ? c.json({profile}) : c.json({error:'成员不存在'},404);
});
app.get('/api/bootstrap', async (c) => {
 const session = c.get('session');
 await syncIdentityChatUsers(c.env);
 await ensureGeneralChannelMembership(c.env.DB,session.userId);
 const [users,channels,dms] = await Promise.all([
  listActiveUsers(c.env.DB,session.userId),listVisibleChannels(c.env.DB,session.userId),listUserDms(c.env.DB,session.userId)
 ]);
 return c.json({users,channels,dms});
});
registerMessageRoutes(app);
registerContactRoutes(app);
registerDmRoutes(app);
registerUserBlockRoutes(app);
registerUploadRoutes(app);
registerChannelRoutes(app);
app.get('/api/ws/:kind/:id', (c) => forwardRoomConnection({env:c.env,request:c.req.raw,kind:c.req.param('kind'),roomId:c.req.param('id'),principal:c.get('session')}));
app.get('/api/inbox/ws', (c) => forwardInboxConnection({env:c.env,request:c.req.raw,principal:c.get('session')}));
app.onError((error,c) => {
 if (error instanceof ApiError) return c.json({error:error.message},error.status);
 console.error(JSON.stringify({event:'chat_error',message:error.message}));
 return c.json({error:'服务器开小差了'},500);
});
export default app;
export { ChannelRoom } from './do/ChannelRoom.js';
export { UserInbox } from './do/UserInbox.js';
