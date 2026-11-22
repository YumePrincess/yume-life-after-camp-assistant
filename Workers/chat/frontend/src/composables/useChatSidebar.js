import { conversationPreview } from "../conversation-preview.js";
import { computed, ref } from "vue";
import api from "../api.js";
import { compareLocalized, formatDate, parseDateValue, t } from "../i18n.js";

function formatListTime(value) {
  if (!value) {
    return "";
  }
  return formatDate(value, { month: "short", day: "numeric" });
}

function mapChannelItem(channel, subtitle) {
  return {
    key: `${channel.kind}:${channel.id}`,
    id: channel.id,
    kind: channel.kind,
    isGeneral: Boolean(channel.isGeneral),
    title: channel.isGeneral ? t("chat.generalGroup") : channel.name,
    subtitle,
    avatarUrl: channel.avatarUrl || "",
    fallback: channel.isGeneral
      ? t("chat.generalGroup").slice(0, 1)
      : channel.name
        ? channel.name.slice(0, 1)
        : t("publicGroups.fallback"),
    lastMessageAt: channel.lastMessageAt || "",
    dateLabel: formatListTime(channel.lastMessageAt),
    unreadCount: Number(channel.unreadCount || 0),
    mentionUnreadCount: Number(channel.mentionUnreadCount || 0),
    source: channel,
  };
}

export function useChatSidebar({
  applyActiveChannel,
  selectDm,
  sidebarApi = api,
}) {
  const channels = ref([]);
  const dms = ref([]);
  const users = ref([]);
  const sidebarLoading = ref(false);
  let activityRevision = 0,
    refreshGeneration = 0,
    unknownRefresh = null;
  const activitySnapshots = new Map();
  function remember(source) {
    activitySnapshots.set(`${source.kind}:${source.id}`, {
      revision: ++activityRevision,
      source: { ...source },
    });
  }
  function syncUnknownConversations() {
    if (!unknownRefresh)
      unknownRefresh = refreshSidebar(true)
        .catch((error) => console.warn("Conversation sync failed", error))
        .finally(() => {
          unknownRefresh = null;
        });
    return unknownRefresh;
  }

  const conversationItems = computed(() => {
    const dmItems = dms.value.map((dm) => ({
      key: `dm:${dm.id}`,
      id: dm.id,
      kind: "dm",
      title: dm.otherUser.displayName,
      subtitle: conversationPreview(dm.lastMessage),
      avatarUrl: dm.otherUser.avatarUrl,
      fallback: dm.otherUser.displayName,
      lastMessageAt: dm.lastMessageAt || "",
      dateLabel: formatListTime(dm.lastMessageAt),
      unreadCount: Number(dm.unreadCount || 0),
      mentionUnreadCount: Number(dm.mentionUnreadCount || 0),
      source: dm,
    }));

    const channelItems = channels.value
      .filter((channel) => channel.isMember)
      .map((channel) =>
        mapChannelItem(channel, conversationPreview(channel.lastMessage)),
      );

    return [...dmItems, ...channelItems].sort((left, right) => {
      if (left.isGeneral !== right.isGeneral) {
        return left.isGeneral ? -1 : 1;
      }

      const leftTime = left.lastMessageAt
        ? parseDateValue(left.lastMessageAt).getTime()
        : 0;
      const rightTime = right.lastMessageAt
        ? parseDateValue(right.lastMessageAt).getTime()
        : 0;
      if (leftTime !== rightTime) {
        return rightTime - leftTime;
      }
      return compareLocalized(left.title, right.title);
    });
  });

  const publicGroupItems = computed(() =>
    channels.value
      .filter((channel) => channel.kind === "public" && !channel.isMember)
      .map((channel) =>
        mapChannelItem(
          channel,
          t("chat.memberCount", { count: Number(channel.memberCount || 0) }),
        ),
      )
      .sort((left, right) => compareLocalized(left.title, right.title)),
  );

  function findConversationSource(kind, roomId) {
    const list = kind === "dm" ? dms.value : channels.value;
    return list.find(
      (item) => item.kind === kind && Number(item.id) === Number(roomId),
    );
  }

  function markConversationRead(kind, roomId) {
    const source = findConversationSource(kind, roomId);
    if (source) {
      source.unreadCount = 0;
      source.mentionUnreadCount = 0;
      remember(source);
    }
  }

  function applyConversationActivity({
    kind,
    roomId,
    lastMessageAt,
    lastMessage,
    unreadCount,
    mentionUnreadCount,
    room,
    sender,
  }) {
    let source = findConversationSource(kind, roomId);
    const missing = !source;
    if (!source && kind === "dm" && room && sender?.id) {
      source = {
        id: Number(roomId),
        kind: "dm",
        name: room.name || "",
        otherUser: { ...sender },
        isBlockedByMe: false,
      };
      dms.value.push(source);
    }
    if (!source) {
      void syncUnknownConversations();
      return;
    }
    const previousId = Number(source.lastMessage?.id || 0);
    const nextId = Number(lastMessage?.id || 0);
    if (nextId && previousId && nextId < previousId) return;
    if (lastMessageAt) source.lastMessageAt = lastMessageAt;
    if (lastMessage !== undefined) source.lastMessage = lastMessage;
    if (unreadCount !== undefined)
      source.unreadCount = Math.max(0, Number(unreadCount || 0));
    if (mentionUnreadCount !== undefined)
      source.mentionUnreadCount = Math.max(0, Number(mentionUnreadCount || 0));
    remember(source);
    if (missing) void syncUnknownConversations();
  }

  async function refreshSidebar(silent = false) {
    const generation = ++refreshGeneration;
    const started = activityRevision;
    if (!silent) sidebarLoading.value = true;
    try {
      const payload = await sidebarApi.bootstrap();
      if (generation !== refreshGeneration) return;
      channels.value = payload.channels || [];
      dms.value = payload.dms || [];
      users.value = payload.users || [];
      // Preserve messages/read changes received while the snapshot was in flight.
      for (const { revision, source } of activitySnapshots.values()) {
        if (revision <= started) continue;
        const list = source.kind === "dm" ? dms.value : channels.value;
        const current = findConversationSource(source.kind, source.id);
        if (!current) list.push({ ...source });
        else if (
          Number(source.lastMessage?.id || 0) >=
          Number(current.lastMessage?.id || 0)
        ) {
          Object.assign(current, {
            lastMessage: source.lastMessage,
            lastMessageAt: source.lastMessageAt,
            unreadCount: source.unreadCount,
            mentionUnreadCount: source.mentionUnreadCount,
          });
        }
      }
      for (const [key, change] of activitySnapshots)
        if (change.revision <= started) activitySnapshots.delete(key);
    } finally {
      if (generation === refreshGeneration) sidebarLoading.value = false;
    }
  }

  async function joinPublicChannel(channel) {
    await sidebarApi.joinChannel(channel.id);
    const joinedChannel = channels.value.find(
      (item) =>
        item.kind === channel.kind && Number(item.id) === Number(channel.id),
    );
    joinedChannel.isMember = true;
    joinedChannel.myRole = "member";
    joinedChannel.memberCount = Number(joinedChannel.memberCount || 0) + 1;
    return joinedChannel;
  }

  async function openConversation(item) {
    if (item.kind === "dm") {
      selectDm(item.source);
      markConversationRead(item.kind, item.id);
      void sidebarApi.markRoomRead(item.kind, item.id).catch(() => {});
      return;
    }

    applyActiveChannel(item.source);
    markConversationRead(item.kind, item.id);
    void sidebarApi.markRoomRead(item.kind, item.id).catch(() => {});
  }

  return {
    channels,
    dms,
    users,
    sidebarLoading,
    conversationItems,
    publicGroupItems,
    markConversationRead,
    applyConversationActivity,
    refreshSidebar,
    openConversation,
    joinPublicChannel,
  };
}
