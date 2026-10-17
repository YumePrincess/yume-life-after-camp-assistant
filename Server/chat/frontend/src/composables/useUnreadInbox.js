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
  isPageActive = () =>
    globalThis.document?.visibilityState === "visible" &&
    globalThis.document.hasFocus(),
}) {
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
      if (event.status === "open")
        void Promise.resolve(refreshConversations()).catch((error) =>
          console.warn("Inbox conversation sync failed", error),
        );
    },
    onMessage(payload) {
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
    disconnectUnreadInbox: inboxSession.disconnect,
  };
}
