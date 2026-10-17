import { validateSession } from '../session.js';
import { isVerifiedInternalRequest, parseVerifiedUserId } from '../verified-identity.js';
import { durableObjectHealth } from '../maintenance/do-health.ts';

export class UserInbox {
  constructor(state, env) {
    this.env = env;
    this.state = state;
    this.connections = new Set();

    for (const socket of this.state.getWebSockets()) {
      this.connections.add(socket);
    }
  }

  async broadcast(packet) {
    for (const socket of this.connections) {
      try {
        const meta = socket.deserializeAttachment();
        const auth = await validateSession(this.env, meta?.token || '');
        if (!auth.ok || auth.session.userId !== meta.userId) {
          socket.close(1008,'Unauthorized'); this.connections.delete(socket); continue;
        }
        socket.send(packet);
      } catch {
        this.connections.delete(socket);
      }
    }
  }

  async fetch(request) {
    const health = durableObjectHealth(request, 'UserInbox');
    if (health) return health;
    const url = new URL(request.url);

    if (url.pathname === '/connect') {
      const userId = parseVerifiedUserId(request);
      const token = url.searchParams.get('token') || '';
      const auth = await validateSession(this.env,token);
      if (!userId || !auth.ok || auth.session.userId !== userId) {
        return new Response('Unauthorized', { status: 401 });
      }

      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected websocket', { status: 426 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      server.serializeAttachment({ userId, token });
      await this.state.storage.setAlarm(Date.now() + 60_000);
      this.connections.add(server);
      server.send(JSON.stringify({ protocolVersion: 1, type: 'ready' }));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/notify' && request.method === 'POST') {
      if (!isVerifiedInternalRequest(request)) {
        return new Response('Unauthorized', { status: 401 });
      }

      const payload = await request.json();
      await this.broadcast(JSON.stringify(payload));
      return Response.json({ ok: true });
    }

    return new Response('Not Found', { status: 404 });
  }

  async alarm() {
    await this.broadcast(JSON.stringify({protocolVersion:1,type:'heartbeat'}));
    if (this.connections.size) await this.state.storage.setAlarm(Date.now()+60_000);
  }

  webSocketClose(ws) {
    this.connections.delete(ws);
  }

  webSocketError(ws) {
    this.connections.delete(ws);
  }
}
