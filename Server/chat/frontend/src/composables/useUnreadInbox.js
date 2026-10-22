import api from "../api.js";
import { createRealtimeSession } from "../realtime-session.js";
import { connectInboxSocket } from "../ws.js";

export function useUnreadInbox({
  activeRoom,
  applyConversationActivity,
  markConversationRead,
  refreshConversations = () => {},
  roomApi = api,
  openInboxConnection = connectInboxSocket,
  notifyInApp = () => {},
  notifySystem = () => {},
  onRoomEvent = () => {},
  isPageActive = () =>
    globalThis.document?.visibilityState === "visible" &&
    globalThis.document.hasFocus(),
}) {
  let presenceSocket = null, presenceTimer = null;
  let hostDocument;
  try { hostDocument = globalThis.window?.top?.document; } catch { /* Cross-origin host. */ }
  function sendPresence() {
    if (presenceSocket?.readyState !== 1) return;
    const deviceId = globalThis.localStorage?.getItem('camp-chat:push-device');
    if (deviceId) presenceSocket.send(JSON.stringify({type:'push_presence',deviceId,foreground:isPageActive()}));
  }
  function stopPresence() {
    if (presenceTimer) clearInterval(presenceTimer);
    presenceTimer = null; presenceSocket = null;
    hostDocument?.removeEventListener('visibilitychange',sendPresence);
    globalThis.window?.top?.removeEventListener('pageshow',sendPresence);
    globalThis.window?.top?.removeEventListener('focus',sendPresence);
    globalThis.window?.top?.removeEventListener('blur',sendPresence);
    globalThis.window?.top?.removeEventListener('pagehide',hidePresence);
  }
  function hidePresence() {
    if (presenceSocket?.readyState === 1) presenceSocket.send(JSON.stringify({type:'push_presence',foreground:false}));
  }
  function isActiveRoom(room) {
    return (
      activeRoom.value &&
      activeRoom.value.kind === room.kind &&
      Number(activeRoom.value.id) === Number(room.id)
    );
  }

  const inboxSession = createRealtimeSession({
    openConnection(_params, handlers) {
      return openInboxConnection(handlers);
    },
    onStatus(event) {
      if (event.status === 'open') {
        stopPresence(); presenceSocket = event.socket; sendPresence();
        hostDocument?.addEventListener('visibilitychange',sendPresence);
        globalThis.window?.top?.addEventListener('pageshow',sendPresence);
        globalThis.window?.top?.addEventListener('focus',sendPresence);
        globalThis.window?.top?.addEventListener('blur',sendPresence);
        globalThis.window?.top?.addEventListener('pagehide',hidePresence);
        if (hostDocument) presenceTimer = setInterval(sendPresence,15000);
      } else if (event.status === 'closed') stopPresence();
      if (event.status === "open")
        void Promise.resolve(refreshConversations()).catch((error) =>
          console.warn("Inbox conversation sync failed", error),
        );
    },
    onMessage(payload) {
      if (['message_deleted','message_recalled'].includes(payload.type) && payload.room) {
        onRoomEvent(payload);
        void Promise.resolve(refreshConversations()).catch(()=>{});
        return;
      }
      if (payload.type !== "room_message" || !payload.room) {
        return;
      }

      const pageActive = isPageActive();
      const needsAttention = Boolean(payload.mentionsMe || payload.replyToMe);
      const reading = isActiveRoom(payload.room) && pageActive;
      applyConversationActivity({
        kind: payload.room.kind,
        roomId: payload.room.id,
        room: payload.room,
        sender: payload.sender,
        lastMessageAt: payload.createdAt,
        lastMessage: {
          id: payload.messageId,
          content: payload.contentPreview || "",
          attachment: payload.attachment || null,
          createdAt: payload.createdAt,
        },
        unreadCount: reading ? 0 : payload.unreadCount,
        mentionUnreadCount: reading ? 0 : payload.mentionUnreadCount,
      });
      if (reading) {
        markConversationRead(payload.room.kind, payload.room.id);
        void roomApi
          .markRoomRead(payload.room.kind, payload.room.id, payload.messageId)
          .catch(() => {});
        if (needsAttention) notifyInApp(payload);
        return;
      }

      if (pageActive) {
        notifyInApp(payload);
      } else {
        notifySystem(payload);
      }
    },
  });

  function connectUnreadInbox() {
    inboxSession.connect("inbox");
  }

  return {
    connectUnreadInbox,
    disconnectUnreadInbox() { stopPresence(); inboxSession.disconnect(); },
  };
}
