import { boundedBody, BodyTooLarge } from "./request-limits";
import {
  getChatPolicy,
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
import { getStorageObject } from "../chat/worker/src/storage-path.js";
// @ts-expect-error Vendored JavaScript module.
import { decryptAttachment } from "../chat/worker/src/encryption.js";

async function audit(
  env: Env,
  actor: string,
  action: string,
  channelId: number | null = null,
) {
  await env.DB.prepare(
    "INSERT INTO chat_admin_audit(actor,action,channel_id) VALUES(?,?,?)",
  )
    .bind(actor, action, channelId)
    .run();
}
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
  if (path === "/policy" && request.method === "GET")
    return json({
      policy: await getChatPolicy(env),
      defaults: CHAT_POLICY_DEFAULTS,
    });
  if (path === "/policy" && request.method === "PUT") {
    if (Number(request.headers.get("content-length")) > 8000)
      return problem("请求体过大", 413);
    try {
      const policy = validateChatPolicy(
        JSON.parse(new TextDecoder().decode(await boundedBody(request, 8000))),
      );
      await audit(env, session.email, "update_chat_policy");
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
    await audit(env, session.email, "list_conversations");
    const [rooms, totals] = await Promise.all([
      env.DB.prepare(`SELECT c.id,c.name,c.kind,c.created_at,c.deleted_at,
        (SELECT count(*) FROM messages m WHERE m.channel_id=c.id AND m.deleted_at IS NULL) AS message_count,
        (SELECT group_concat(u.display_name, '、') FROM channel_members cm JOIN users u ON u.id=cm.user_id WHERE cm.channel_id=c.id) AS members
        FROM channels c WHERE c.deleted_at IS NULL AND c.id < ? ORDER BY c.id DESC LIMIT 100`)
        .bind(Number(url.searchParams.get("before")) || Number.MAX_SAFE_INTEGER)
        .all(),
      env.DB.prepare(`SELECT (SELECT count(*) FROM channels WHERE deleted_at IS NULL) AS rooms,
        (SELECT count(*) FROM messages WHERE deleted_at IS NULL) AS messages,
        (SELECT count(*) FROM uploaded_files) AS files,
        (SELECT coalesce(sum(size),0) FROM uploaded_files) AS file_bytes`).first(),
    ]);
    return json({ rooms: rooms.results, totals });
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
    await audit(env, session.email, "delete_group", id);
    return json(await hardDeleteChannel(env.DB, id));
  }
  const messagesMatch = /^\/rooms\/(\d+)\/messages$/.exec(path);
  if (messagesMatch && request.method === "GET") {
    const id = Number(messagesMatch[1]);
    const room = await env.DB.prepare(
      "SELECT id,name,kind FROM channels WHERE id=? AND deleted_at IS NULL",
    )
      .bind(id)
      .first();
    if (!room) return problem("会话不存在", 404);
    await audit(env, session.email, "read_messages", id);
    const before = Number(url.searchParams.get("before")) || null;
    const messages = await chatMessages.listMessages(env, id, before, 50);
    return json({ room, messages });
  }
  const messageMatch = /^\/rooms\/(\d+)\/messages\/(\d+)$/.exec(path);
  if (messageMatch && request.method === "DELETE") {
    const roomId = Number(messageMatch[1]),
      messageId = Number(messageMatch[2]);
    await audit(env, session.email, `delete_message:${messageId}`, roomId);
    const deleted = await chatMessages.softDeleteMessage(env.DB, {
      channelId: roomId,
      messageId,
    });
    if (!deleted) return problem("消息不存在", 404);
    const room = await env.DB.prepare("SELECT kind FROM channels WHERE id=?")
      .bind(roomId)
      .first<{ kind: string }>();
    if (room && env.CHANNEL_ROOM) {
      try {
        await env.CHANNEL_ROOM.getByName(`${room.kind}:${roomId}`).fetch(
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
    await audit(env, session.email, "list_files");
    const before =
      Number(url.searchParams.get("before")) || Number.MAX_SAFE_INTEGER;
    const files =
      await env.DB.prepare(`SELECT f.rowid AS cursor,f.object_key,f.filename,f.content_type,f.size,f.created_at,u.display_name
      FROM uploaded_files f LEFT JOIN users u ON u.id=f.owner_user_id WHERE f.rowid < ? ORDER BY f.rowid DESC LIMIT 50`)
        .bind(before)
        .all();
    return json({ files: files.results });
  }
  if (path === "/file" && request.method === "GET") {
    const key = url.searchParams.get("key") || "";
    const file = await env.DB.prepare(
      "SELECT filename,content_type FROM uploaded_files WHERE object_key=?",
    )
      .bind(key)
      .first<{ filename: string; content_type: string }>();
    if (!file || !env.FILES) return problem("文件不存在", 404);
    await audit(env, session.email, `read_file:${key}`);
    const object = await getStorageObject(env, key);
    if (!object) return problem("文件不存在", 404);
    const bytes = await decryptAttachment(env, await object.arrayBuffer(), key);
    return new Response(bytes, {
      headers: {
        "Content-Type": file.content_type,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  if (path === "/audit" && request.method === "GET") {
    const rows = await env.DB.prepare(
      "SELECT * FROM chat_admin_audit ORDER BY id DESC LIMIT 100",
    ).all();
    return json({ events: rows.results });
  }
  return problem("Not found", 404);
}
