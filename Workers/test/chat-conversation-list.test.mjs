import { describe, expect, it, vi } from "vitest";
import { ref } from "vue";
vi.mock("../chat/frontend/src/api.js", () => ({ default: {} }));
vi.mock("../chat/frontend/src/ws.js", () => ({ connectInboxSocket: vi.fn() }));
vi.mock("../chat/frontend/src/i18n.js", () => ({
  t: (key) => key,
  formatDate: () => "",
  parseDateValue: value => new Date(value),
  compareLocalized: (a, b) => a.localeCompare(b),
}));
import { useChatSidebar } from "../chat/frontend/src/composables/useChatSidebar.js";
import { useUnreadInbox } from "../chat/frontend/src/composables/useUnreadInbox.js";
import { conversationPreview } from "../chat/frontend/src/conversation-preview.js";

const dm = {
  id: 7,
  kind: "dm",
  otherUser: { id: 2, displayName: "成员二", username: "成员二" },
  lastMessage: { id: 1, content: "first message" },
  unreadCount: 0,
};
const defer = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function sidebar(
  bootstrap = vi
    .fn()
    .mockResolvedValue({ channels: [], dms: [structuredClone(dm)], users: [] }),
) {
  const selected = vi.fn();
  return {
    ...useChatSidebar({
      applyActiveChannel: vi.fn(),
      selectDm: selected,
      sidebarApi: { bootstrap, markRoomRead: vi.fn().mockResolvedValue({}) },
    }),
    selected,
    bootstrap,
  };
}
const activity = {
  kind: "dm",
  roomId: 7,
  lastMessageAt: "2026-10-17T08:00:00Z",
  lastMessage: { id: 2, content: "**new message**\nsecond line" },
  unreadCount: 1,
  mentionUnreadCount: 0,
};

describe("conversation card previews and incoming private chats", () => {
  it("uses the current name above a single-line message preview for groups and private chats", async () => {
    const state = sidebar(
      vi.fn().mockResolvedValue({
        dms: [structuredClone(dm)],
        channels: [
          {
            id: 1,
            kind: "public",
            name: "general",
            isGeneral: true,
            isMember: true,
            lastMessage: { id: 4, content: "群聊最新消息" },
          },
        ],
      }),
    );
    await state.refreshSidebar();
    expect(
      state.conversationItems.value.map((item) => [item.title, item.subtitle]),
    ).toEqual([
      ["chat.generalGroup", "群聊最新消息"],
      ["成员二", "first message"],
    ]);
    state.applyConversationActivity(activity);
    expect(state.conversationItems.value[1].subtitle).toBe(
      "new message second line",
    );
    expect(state.conversationItems.value[1].unreadCount).toBe(1);
  });
  it.each([
    [{ attachment: { kind: "voice" } }, "voice.fallback"],
    [{ attachment: { type: "image/png" } }, "conversation.image"],
    [{ attachment: { type: "video/mp4" } }, "conversation.video"],
    [{ attachment: { type: "audio/mpeg" } }, "conversation.audio"],
    [{ attachment: { name: "report.pdf" } }, "report.pdf"],
    [null, "chat.noMessages"],
  ])("formats attachment or empty-message previews (%j)", (message, expected) =>
    expect(conversationPreview(message)).toBe(expected));
  it("inserts the first incoming private conversation immediately without switching the active room", async () => {
    const request = defer();
    const state = sidebar(vi.fn().mockReturnValue(request.promise));
    state.applyConversationActivity({
      ...activity,
      room: { id: 7, kind: "dm", name: "dm:1:2" },
      sender: dm.otherUser,
    });
    expect(state.conversationItems.value[0].title).toBe("成员二");
    expect(state.conversationItems.value[0].subtitle).toBe(
      "new message second line",
    );
    expect(state.selected).not.toHaveBeenCalled();
    expect(state.bootstrap).toHaveBeenCalledTimes(1);
    request.resolve({
      dms: [{ ...dm, lastMessage: activity.lastMessage, unreadCount: 1 }],
      channels: [],
    });
    await vi.waitFor(() => expect(state.dms.value[0].unreadCount).toBe(1));
  });
  it("does not lose a newly received conversation or read state to an older in-flight snapshot", async () => {
    const old = defer(),
      current = defer();
    const state = sidebar(
      vi
        .fn()
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(current.promise),
    );
    const initial = state.refreshSidebar();
    state.applyConversationActivity({
      ...activity,
      room: { id: 7, kind: "dm" },
      sender: dm.otherUser,
    });
    state.markConversationRead("dm", 7);
    current.resolve({ dms: [structuredClone(dm)], channels: [] });
    await vi.waitFor(() => expect(state.dms.value[0].lastMessage.id).toBe(2));
    old.resolve({ dms: [], channels: [] });
    await initial;
    expect(state.conversationItems.value).toHaveLength(1);
    expect(state.conversationItems.value[0].subtitle).toBe(
      "new message second line",
    );
    expect(state.conversationItems.value[0].unreadCount).toBe(0);
  });
  it("ignores duplicate or delayed older message previews and refreshes a missing room without usable sender data", async () => {
    const state = sidebar();
    await state.refreshSidebar();
    state.applyConversationActivity(activity);
    state.applyConversationActivity({
      ...activity,
      lastMessage: { id: 1, content: "old" },
      unreadCount: 9,
    });
    expect(state.conversationItems.value[0].subtitle).toBe(
      "new message second line",
    );
    expect(state.conversationItems.value[0].unreadCount).toBe(1);
    state.applyConversationActivity({ kind: "private", roomId: 99 });
    expect(state.bootstrap).toHaveBeenCalledTimes(2);
  });
  it("syncs after inbox connect/reconnect and updates previews even while the room is being read", async () => {
    let handlers;
    const socket = { readyState: 0, close: vi.fn() };
    const refresh = vi.fn().mockResolvedValue({}),
      apply = vi.fn(),
      read = vi.fn(),
      notify = vi.fn();
    const roomApi = { markRoomRead: vi.fn().mockResolvedValue({}) };
    const inbox = useUnreadInbox({
      activeRoom: ref({ kind: "dm", id: 7 }),
      applyConversationActivity: apply,
      markConversationRead: read,
      refreshConversations: refresh,
      roomApi,
      notifyInApp: notify,
      isPageActive: () => true,
      openInboxConnection: (value) => {
        handlers = value;
        return socket;
      },
    });
    inbox.connectUnreadInbox();
    socket.readyState = 1;
    handlers.onStatus({ status: "open", socket });
    expect(refresh).toHaveBeenCalledTimes(1);
    handlers.onMessage(
      JSON.stringify({
        type: "room_message",
        room: { kind: "dm", id: 7 },
        messageId: 5,
        contentPreview: "live preview",
        unreadCount: 1,
        sender: dm.otherUser,
      }),
      socket,
    );
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        lastMessage: expect.objectContaining({
          id: 5,
          content: "live preview",
        }),
        unreadCount: 0,
      }),
    );
    expect(read).toHaveBeenCalledWith("dm", 7);
    expect(notify).not.toHaveBeenCalled();
    inbox.disconnectUnreadInbox();
  });
});
