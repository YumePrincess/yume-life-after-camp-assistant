import { decryptMessageContent } from "../encryption.js";

// Only project the latest non-deleted message in rooms this user actually joined.
// Discovery cards must not disclose conversation contents through bootstrap.
export async function attachConversationPreviews(env, rooms, userId) {
  const allowed = rooms.filter((room) => room.kind === "dm" || room.isMember);
  const latest = new Map();
  for (let offset = 0; offset < allowed.length; offset += 80) {
    const ids = allowed
      .slice(offset, offset + 80)
      .map((room) => Number(room.id));
    const { results } = await env.DB.prepare(`SELECT m.* FROM messages m
      JOIN channel_members membership ON membership.channel_id=m.channel_id AND membership.user_id=?
      JOIN channels c ON c.id=m.channel_id AND c.deleted_at IS NULL
      WHERE m.channel_id IN (${ids.map(() => "?").join(",")}) AND m.deleted_at IS NULL
      AND m.id=(SELECT max(last.id) FROM messages last WHERE last.channel_id=m.channel_id AND last.deleted_at IS NULL)`)
      .bind(Number(userId), ...ids)
      .all();
    for (const row of results) {
      const content = await decryptMessageContent(env, row.content, {
        channelId: row.channel_id,
        senderId: row.sender_id ?? 0,
        senderContext:
          row.sender_kind === "external"
            ? `${row.source}:${row.external_sender_id}`
            : "",
      });
      latest.set(Number(row.channel_id), {
        id: Number(row.id),
        content: String(content || "").slice(0, 512),
        createdAt: row.created_at,
        attachment: row.attachment_key
          ? {
              name: row.attachment_name || "",
              type: row.attachment_type || "",
              kind: row.attachment_kind || "",
            }
          : null,
      });
    }
  }
  return rooms.map((room) => ({
    ...room,
    lastMessage: latest.get(Number(room.id)) || null,
    ...(latest.has(Number(room.id))
      ? { lastMessageAt: latest.get(Number(room.id)).createdAt }
      : {}),
  }));
}
