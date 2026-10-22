import { loadPushKey, deviceStoreKey, validSubscription, pushNotification, sendWebPush } from '../push.js';
import { IdentityDirectory, DIRECTORY_MARKER } from "./IdentityDirectory.js";
import { validateSession } from "../session.js";
import {
  isVerifiedInternalRequest,
  parseVerifiedUserId,
} from "../verified-identity.js";
import { durableObjectHealth } from "../maintenance/do-health.ts";

export class UserInbox {
  constructor(state, env) {
    this.env = env;
    this.state = state;
    this.connections = new Set();


    for (const socket of this.state.getWebSockets()) {
      if (socket.deserializeAttachment()?.kind !== DIRECTORY_MARKER)
        this.connections.add(socket);
    }
  }

  async broadcast(packet) {
    for (const socket of this.connections) {
      try {
        const meta = socket.deserializeAttachment();
        const auth = await validateSession(this.env, meta?.token || "");
        if (!auth.ok || auth.session.userId !== meta.userId) {
          socket.close(1008, "Unauthorized");
          this.connections.delete(socket);
          continue;
        }
        socket.send(packet);
      } catch {
        this.connections.delete(socket);
      }
    }
  }

  async fetch(request) {
    const health = durableObjectHealth(request, "UserInbox");
    if (health) return health;
    const url = new URL(request.url);
    if (url.pathname.startsWith("/directory/"))
      return this.directory().fetch(request);

    if (url.pathname.startsWith('/push/')) {
      const userId = parseVerifiedUserId(request);
      const auth = await validateSession(this.env, url.searchParams.get('token') || '');
      if (!userId || !auth.ok || auth.session.userId !== userId) return new Response('Unauthorized', {status:401});
      if (url.pathname === '/push/key' && request.method === 'GET')
        return Response.json({publicKey:(await this.pushKey()).publicKey},{headers:{'Cache-Control':'private, no-store'}});
      if (url.pathname !== '/push/subscription' || !['PUT','DELETE'].includes(request.method)) return new Response('Not found',{status:404});
      let value;
      try { value = await request.json(); } catch { return new Response('Invalid JSON',{status:400}); }
      if (!value || typeof value !== 'object') return new Response('Invalid subscription',{status:400});
      if (!/^[a-zA-Z0-9-]{16,64}$/.test(value.deviceId || '')) return new Response('Invalid device',{status:400});
      const devices = await this.state.storage.get(deviceStoreKey) || {};
      if (request.method === 'DELETE') delete devices[value.deviceId];
      else {
        if (!validSubscription(value.subscription)) return new Response('Invalid subscription',{status:400});
        devices[value.deviceId] = {subscription:{endpoint:value.subscription.endpoint,expirationTime:null,keys:{p256dh:value.subscription.keys.p256dh,auth:value.subscription.keys.auth}}, token:auth.session.token, userId,
          language:String(value.language || 'en').slice(0,20),
          mutedRooms:Array.isArray(value.mutedRooms) ? value.mutedRooms.filter(x => /^(dm|channel):[1-9][0-9]*$/.test(x)).slice(0,200) : [],
          updated:Date.now(), subject:url.origin};
        const ids = Object.keys(devices).sort((a,b)=>devices[b].updated-devices[a].updated);
        ids.slice(10).forEach(id=>delete devices[id]);
      }
      await this.state.storage.put(deviceStoreKey, devices);
      return Response.json({ok:true},{headers:{'Cache-Control':'private, no-store'}});
    }

    if (url.pathname === "/connect") {
      const userId = parseVerifiedUserId(request);
      const token = url.searchParams.get("token") || "";
      const auth = await validateSession(this.env, token);
      if (!userId || !auth.ok || auth.session.userId !== userId) {
        return new Response("Unauthorized", { status: 401 });
      }

      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      server.serializeAttachment({ userId, token });
      await this.state.storage.setAlarm(Date.now() + 60_000);
      this.connections.add(server);
      server.send(JSON.stringify({ protocolVersion: 1, type: "ready" }));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/notify" && request.method === "POST") {
      if (!isVerifiedInternalRequest(request)) {
        return new Response("Unauthorized", { status: 401 });
      }

      const payload = await request.json();
      await this.broadcast(JSON.stringify(payload));
      if (payload.type === "room_message" && payload.room) this.state.waitUntil(this.push(payload));
      return Response.json({ ok: true });
    }

    return new Response("Not Found", { status: 404 });
  }

  pushKey() {
    return this.pushKeyReady ||= this.state.blockConcurrencyWhile(() => loadPushKey(this.state.storage));
  }

  async push(event) {
    const devices = await this.state.storage.get(deviceStoreKey) || {};
    const deliveries = await Promise.allSettled(Object.entries(devices).map(async ([id, device]) => {
      const auth = await validateSession(this.env, device.token);
      if (!auth.ok || auth.session.userId !== device.userId) { await this.removePushDevice(id, device); return; }
      if (device.mutedRooms.includes(`${event.room.kind}:${Number(event.room.id)}`) && !event.mentionsMe && !event.replyToMe) return;
      const foreground = [...this.connections].some(socket => {
        const meta = socket.deserializeAttachment();
        return meta?.deviceId === id && meta.foreground && Date.now() - meta.presenceAt < 45000;
      });
      if (foreground) return;
      try {
        const status = await sendWebPush(device.subscription, await this.pushKey(), pushNotification(event, device.language), device.subject);
        if (status === 404 || status === 410) await this.removePushDevice(id, device);
      } catch { console.warn('Web Push delivery failed'); }
    }));
    if (deliveries.some(result => result.status === 'rejected')) console.warn('Web Push session validation failed');
  }

  async removePushDevice(id, previous) {
    // Delivery can overlap preference updates; never remove a newly renewed subscription.
    await this.state.storage.transaction(async storage => {
      const devices = await storage.get(deviceStoreKey) || {};
      if (devices[id]?.updated === previous.updated) { delete devices[id]; await storage.put(deviceStoreKey, devices); }
    });
  }

  directory() {
    return (this.identityDirectory ||= new IdentityDirectory(
      this.state,
      this.env,
    ));
  }

  async webSocketMessage(ws, message) {
    if (ws.deserializeAttachment()?.kind === DIRECTORY_MARKER) {
      await this.directory().webSocketMessage(ws, message); return;
    }
    if (typeof message !== 'string' || message.length > 512) return;
    try {
      const payload = JSON.parse(message), meta = ws.deserializeAttachment();
      if (payload.type !== 'push_presence' || !meta?.userId) return;
      if (payload.foreground === false) { ws.serializeAttachment({...meta,foreground:false}); return; }
      if (!/^[a-zA-Z0-9-]{16,64}$/.test(payload.deviceId || '')) return;
      ws.serializeAttachment({...meta,deviceId:payload.deviceId,foreground:payload.foreground === true,presenceAt:Date.now()});
    } catch { /* Ignore unknown or malformed client frames. */ }
  }

  async alarm() {
    if (await this.state.storage.get(DIRECTORY_MARKER)) {
      await this.directory().refresh();
      return;
    }
    await this.broadcast(
      JSON.stringify({ protocolVersion: 1, type: "heartbeat" }),
    );
    if (this.connections.size)
      await this.state.storage.setAlarm(Date.now() + 60_000);
  }

  async webSocketClose(ws) {
    if (ws.deserializeAttachment()?.kind === DIRECTORY_MARKER) {
      await this.directory().disconnect(ws);
      return;
    }
    this.connections.delete(ws);
  }

  async webSocketError(ws) {
    if (ws.deserializeAttachment()?.kind === DIRECTORY_MARKER) {
      ws.close(1011, "Connection error");
      await this.directory().disconnect(ws);
      return;
    }
    this.connections.delete(ws);
  }
}
