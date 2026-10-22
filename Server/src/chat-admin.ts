// @ts-expect-error Vendored JavaScript module.
import { syncIdentityChatUsers } from "../chat/worker/src/session.js";
// @ts-expect-error Vendored JavaScript module.
import { activeUserSql } from "../chat/worker/src/user-status.js";
// @ts-expect-error Vendored JavaScript module.
import { notifyRoomDeletion } from "../chat/worker/src/room-change.js";
import { boundedBody, BodyTooLarge } from "./request-limits";
import { adminGeneralAvatarUrl, handleGeneralAvatar, generalAvatarKey } from "./chat-general-avatar";
import {
  getChatPolicy,
  getChatTimezone,
  validateChatPolicy,
  CHAT_POLICY_DEFAULTS,
} from "./chat-policy";
import { hasPermission, isDemoSession } from "./auth";
import type { SessionRow } from "./db";
import { json, problem } from "./response";
// @ts-expect-error Vendored JavaScript module.
import * as chatMessages from "../chat/worker/src/data/messages.js";
import { hardDeleteChannel } from "../chat/worker/src/data/channel-deletion";
// @ts-expect-error Vendored JavaScript module.
import { readAttachment } from "../chat/worker/src/attachment-reader.js";
// @ts-expect-error Vendored JavaScript module.
import { cleanupR2Keys } from "../chat/worker/src/gc.js";

export async function handleChatAdmin(
  request: Request,
  env: Env,
  session: SessionRow,
): Promise<Response> {
  if (
    !["oidc", "temporary_key"].includes(session.auth_method) ||
    isDemoSession(session) ||
    !hasPermission(session, "admin:chat")
  )
    return problem("没有聊天管理权限", 403, "permission_denied");
  const url = new URL(request.url);
  const path = url.pathname.slice("/api/admin/chat".length);
  if (path === "/general/avatar") return handleGeneralAvatar(request, env);
  if (path === "/policy" && request.method === "GET")
    return json({
      policy: await getChatPolicy(env),
      defaults: CHAT_POLICY_DEFAULTS,
      timezone: await getChatTimezone(env),
    });
  if (path === "/policy" && request.method === "PUT") {
    if (Number(request.headers.get("content-length")) > 8000)
      return problem("请求体过大", 413);
    try {
      const policy = validateChatPolicy(
        JSON.parse(new TextDecoder().decode(await boundedBody(request, 8000))),
      );

      await env.DB.prepare(
        "INSERT INTO settings(key,value,updated_at) VALUES('chat_policy',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
      )
        .bind(JSON.stringify(policy), new Date().toISOString())
        .run();
      return json({ policy });
    } catch (error) {
      if (error instanceof BodyTooLarge) return problem("请求体过大", 413);
      return problem(
        error instanceof Error ? error.message : "聊天参数无效",
        400,
      );
    }
  }
  if (path === "" && request.method === "GET") {
    await syncIdentityChatUsers(env);
    const [rooms, totals, general] = await Promise.all([
      env.DB.prepare(`SELECT c.id,c.name,c.kind,c.created_at,c.deleted_at,
        (SELECT count(*) FROM messages m WHERE m.channel_id=c.id AND m.deleted_at IS NULL) AS message_count,
        (SELECT group_concat(u.display_name, '、') FROM channel_members cm JOIN users u ON u.id=cm.user_id WHERE cm.channel_id=c.id AND u.deleted_at IS NULL AND ${activeUserSql('u')}) AS members
        FROM channels c WHERE c.deleted_at IS NULL AND c.id < ? ORDER BY c.id DESC LIMIT 100`)
        .bind(Number(url.searchParams.get("before")) || Number.MAX_SAFE_INTEGER)
        .all(),
      env.DB.prepare(`SELECT (SELECT count(*) FROM channels WHERE deleted_at IS NULL) AS rooms,
        (SELECT count(*) FROM messages WHERE deleted_at IS NULL) AS messages,
        (SELECT count(*) FROM uploaded_files) AS files,
        (SELECT coalesce(sum(size),0) FROM uploaded_files) AS file_bytes`).first(),
      generalAvatarKey(env),
    ]);
    return json({ rooms: rooms.results, totals, generalAvatar: { avatarUrl: adminGeneralAvatarUrl(general) }, timezone: await getChatTimezone(env) });
  }
  const roomMatch = /^\/rooms\/(\d+)$/.exec(path);
  if (roomMatch && request.method === "DELETE") {
    const id = Number(roomMatch[1]);
    const room = await env.DB.prepare(
      "SELECT name,kind FROM channels WHERE id=? AND deleted_at IS NULL",
    )
      .bind(id)
      .first<{ name: string; kind: string }>();
    if (!room || room.name === "general" || room.kind === "dm")
      return problem("该会话不能删除", 400);

    return json(await hardDeleteChannel(env.DB, id));
  }
  const messagesMatch = /^\/rooms\/(\d+)\/messages$/.exec(path);
  if (messagesMatch && request.method === "GET") {
    const id = Number(messagesMatch[1]);
    await syncIdentityChatUsers(env);
    const room = await env.DB.prepare(
      `SELECT id,name,kind,
       (SELECT group_concat(u.display_name, '、') FROM channel_members cm JOIN users u ON u.id=cm.user_id WHERE cm.channel_id=channels.id AND u.deleted_at IS NULL AND ${activeUserSql('u')}) AS members,
       (SELECT count(*) FROM messages WHERE channel_id=channels.id AND deleted_at IS NULL) AS messageCount,
       (SELECT count(*) FROM messages WHERE deleted_at IS NULL) AS totalMessageCount
       FROM channels WHERE id=? AND deleted_at IS NULL`,
    )
      .bind(id)
      .first();
    if (!room) return problem("会话不存在", 404);

    const before = Number(url.searchParams.get("before")) || null;
    const messages = await chatMessages.listMessages(env, id, before, 50, {includeRecalledContent:true});
    return json({ room, messages, timezone: await getChatTimezone(env) });
  }
  const messageMatch = /^\/rooms\/(\d+)\/messages\/(\d+)$/.exec(path);
  if (messageMatch && request.method === "DELETE") {
    const roomId = Number(messageMatch[1]),
      messageId = Number(messageMatch[2]);
    const attachment = await env.DB.prepare('SELECT attachment_key FROM messages WHERE id=? AND channel_id=?')
      .bind(messageId,roomId).first<{attachment_key: string | null}>();
    const deleted = await chatMessages.softDeleteMessage(env.DB, {
      channelId: roomId,
      messageId,
    });
    if (!deleted) return problem("消息不存在", 404);
    if (attachment?.attachment_key) await cleanupR2Keys(env, [attachment.attachment_key]);
    const room = await env.DB.prepare("SELECT kind FROM channels WHERE id=?")
      .bind(roomId)
      .first<{ kind: string }>();
    if (room && env.USER_INBOX) {
      try { await notifyRoomDeletion(env, {id:roomId,kind:room.kind}, messageId); }
      catch { console.warn('Admin deletion inbox delivery failed'); }
    }
    if (room && env.CHANNEL_ROOM) {
      try {
        const delivered = await env.CHANNEL_ROOM.get(env.CHANNEL_ROOM.idFromName(`${room.kind}:${roomId}`)).fetch(
          "https://cfchat.internal/moderation-event",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-cfchat-internal-auth": "worker-verified",
            },
            body: JSON.stringify({ type: "message_deleted", messageId }),
          },
        );
        if (!delivered.ok) throw new Error(`Moderation delivery failed: ${delivered.status}`);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "chat_moderation_delivery_failed",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
    return json({ ok: true });
  }
  if (path === "/files" && request.method === "GET") {
    const before =
      Number(url.searchParams.get("before")) || Number.MAX_SAFE_INTEGER;
    const files =
      await env.DB.prepare(`SELECT f.rowid AS cursor,f.object_key,f.filename,f.content_type,f.size,f.created_at,u.display_name
      FROM uploaded_files f LEFT JOIN users u ON u.id=f.owner_user_id WHERE f.rowid < ? ORDER BY f.rowid DESC LIMIT 50`)
        .bind(before)
        .all();
    return json({ files: files.results, timezone: await getChatTimezone(env) });
  }
  if (path === "/file" && request.method === "GET") {
    const key = url.searchParams.get("key") || "";
    const file = await env.DB.prepare(
      "SELECT filename,content_type FROM uploaded_files WHERE object_key=?",
    )
      .bind(key)
      .first<{ filename: string; content_type: string }>();
    if (!file || !env.FILES) return problem("文件不存在", 404);

    const result = await readAttachment(env, key, request.headers.get("range"));
    if (!result) return problem("文件不存在", 404);
    result.headers.set("Content-Type", file.content_type);
    result.headers.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
    result.headers.set("X-Content-Type-Options", "nosniff");
    return new Response(result.body, { status: result.status, headers: result.headers });
  }
  return problem("Not found", 404);
}
