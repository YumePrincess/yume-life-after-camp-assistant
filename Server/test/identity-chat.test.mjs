import { attachConversationPreviews } from "../chat/worker/src/data/conversation-previews.js";
import { ensureDmChannel } from "../chat/worker/src/data/dm-provisioning.js";
import {
  IdentityDirectory,
  DIRECTORY_MARKER,
} from "../chat/worker/src/do/IdentityDirectory.js";
import {
  chatDirectoryMutation,
  notifyChatDirectory,
} from "../src/chat-directory";
import { handleIdentityPasswordChange } from "../src/identity-password-change";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("worker-mailer", () => ({ WorkerMailer: class {} }));
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import {
  keyedHash,
  encryptSecret,
  hashPassword,
  verifyPassword,
} from "../src/crypto";
import {
  issueIdentitySession,
  validateIdentitySession,
  revokeIdentitySession,
  identityRequestAllowed,
  withIdentityRequestSession,
} from "../src/identity-session";
import { verifyIdentityPassword } from "../src/identity";
import { getChatPolicy, validateChatPolicy } from "../src/chat-policy";
import { handleChat } from "../src/chat";
import { handleChatAdmin } from "../src/chat-admin";
import { requireAdmin } from "../src/auth";
import { handleIdentityAvatar } from "../src/identity-avatar";
import chatApp from "../chat/worker/src/index.js";
import {
  validateSession,
  syncIdentityChatUsers,
} from "../chat/worker/src/session.js";
import { insertMessage } from "../chat/worker/src/data/messages.js";
import { saveUploadedFile } from "../chat/worker/src/api/upload.js";
import { runScheduledGc } from "../chat/worker/src/gc.js";

function d1(sqlite) {
  return {
    prepare(sql) {
      let args = [];
      return {
        bind(...values) {
          args = values;
          return this;
        },
        async first(column) {
          const row = sqlite.prepare(sql).get(...args);
          return column ? (row?.[column] ?? null) : (row ?? null);
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...args), success: true };
        },
        async run() {
          const result = sqlite.prepare(sql).run(...args);
          return {
            success: true,
            meta: {
              changes: Number(result.changes),
              last_row_id: Number(result.lastInsertRowid),
            },
          };
        },
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const result = [];
        for (const item of statements) result.push(await item.run());
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
const origin = "https://camp.example";
const req = (path, options = {}) => new Request(origin + path, options);
const admin = {
  email: "admin@example.com",
  auth_method: "temporary_key",
  permissions_json: '["admin:chat"]',
};
let sqlite, env, objects, cookie, token;
async function identity(id = "one", name = "雨梦", code = "12345678") {
  await env.DB.prepare(`INSERT INTO identity_codes(id,code_hash,code_encrypted,player_name,email,status,created_by,created_at,updated_at,password_hash)
 VALUES(?,?,?,?,?,'active','test',?,?,?)`)
    .bind(
      id,
      await keyedHash(env, "identity-code", code),
      await encryptSecret(env, "identity-code-value", code),
      name,
      `${id}@example.com`,
      new Date().toISOString(),
      new Date().toISOString(),
      await hashPassword("test-password"),
    )
    .run();
  return id;
}
async function login(code = "12345678") {
  const session = await issueIdentitySession(
    env,
    req("/api/public/identity-login"),
    code,
  );
  cookie = session.cookie.split(";")[0];
  token = cookie.split("=")[1];
  return cookie;
}
async function bootstrap() {
  return chatApp.request(
    req("/api/bootstrap", { headers: { cookie } }),
    undefined,
    env,
  );
}
function jsonHeaders() {
  return { cookie, origin, "Content-Type": "application/json" };
}
beforeEach(async () => {
  sqlite = new DatabaseSync(":memory:");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(migrations)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
  objects = new Map();
  env = {
    DB: d1(sqlite),
    SESSION_SECRET: "test-secret-for-identity-and-chat-at-least-32-chars",
    STORAGE_PREFIX: "lifeafter",
    ASSETS: {
      fetch: async () =>
        new Response("<html>chat</html>", {
          headers: { "Content-Type": "text/html" },
        }),
    },
    FILES: {
      async put(key, bytes, options = {}) {
        objects.set(key, { bytes: new Uint8Array(bytes), ...options });
      },
      async delete(key) {
        objects.delete(key);
      },
      async get(key) {
        const obj = objects.get(key);
        return obj
          ? {
              body: obj.bytes,
              httpMetadata: obj.httpMetadata,
              writeHttpMetadata(headers) {
                if (obj.httpMetadata?.contentType)
                  headers.set("Content-Type", obj.httpMetadata.contentType);
              },
              arrayBuffer: async () => obj.bytes.buffer,
            }
          : null;
      },
    },
  };
  await identity();
  await login();
});
afterEach(() => sqlite.close());

describe("identity cookie and permanent identity number", () => {
  it("issues an HttpOnly cookie and reuses a valid session", async () => {
    const session = await issueIdentitySession(
      env,
      req("/api/public/identity-login", { headers: { cookie } }),
      "12345678",
    );
    expect(session.cookie).toContain("HttpOnly; SameSite=Strict");
    expect(session.cookie).toContain("Secure");
    expect(session.cookie.startsWith(cookie + ";")).toBe(true);
    expect((await validateIdentitySession(env, token)).id).toBe("one");
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM identity_web_sessions").get().n,
    ).toBe(1);
    expect(
      sqlite.prepare("SELECT token_hash FROM identity_web_sessions").get()
        .token_hash,
    ).not.toBe(token);
  });
  it.each([
    "disabled",
    "expired",
    "password",
    "logout",
  ])("revokes access after %s", async (kind) => {
    if (kind === "disabled")
      sqlite
        .prepare("UPDATE identity_codes SET status='disabled' WHERE id='one'")
        .run();
    if (kind === "expired")
      sqlite
        .prepare(
          "UPDATE identity_codes SET expires_at='2000-01-01T00:00:00Z' WHERE id='one'",
        )
        .run();
    if (kind === "password")
      sqlite
        .prepare(
          "UPDATE identity_codes SET password_hash='new-hash' WHERE id='one'",
        )
        .run();
    if (kind === "logout")
      await revokeIdentitySession(
        env,
        req("/api/public/identity-session", { headers: { cookie } }),
      );
    expect(await validateIdentitySession(env, token)).toBeNull();
    expect(
      (
        await handleChat(
          req("/chat/api/bootstrap", { headers: { cookie } }),
          env,
        )
      ).status,
    ).toBe(401);
  });
  it("does not revive an old cookie after a disable/enable cycle", async () => {
    sqlite
      .prepare("UPDATE identity_codes SET status='disabled' WHERE id='one'")
      .run();
    sqlite
      .prepare("UPDATE identity_codes SET status='active' WHERE id='one'")
      .run();
    expect(await validateIdentitySession(env, token)).toBeNull();
  });
  it("never permits expired identities to mint a chat session", async () => {
    sqlite
      .prepare(
        "UPDATE identity_codes SET expires_at='2000-01-01T00:00:00Z' WHERE id='one'",
      )
      .run();
    expect(
      (await issueIdentitySession(env, req("/"), "12345678")).cookie,
    ).toContain("Max-Age=0");
  });
  it("locks the signed number while allowing profile changes", () => {
    expect(() =>
      sqlite
        .prepare(
          "UPDATE identity_codes SET code_hash='different' WHERE id='one'",
        )
        .run(),
    ).toThrow("immutable");
    expect(() =>
      sqlite
        .prepare(
          "UPDATE identity_codes SET code_encrypted='different' WHERE id='one'",
        )
        .run(),
    ).toThrow("immutable");
    expect(() =>
      sqlite
        .prepare(
          "UPDATE identity_codes SET player_name='新名称' WHERE id='one'",
        )
        .run(),
    ).not.toThrow();
  });
  it("uses request-local cookie authentication for voting without storing passwords", async () => {
    const wrapped = await withIdentityRequestSession(
      req("/api/public/vote", { method: "POST", headers: { cookie, origin } }),
      env,
    );
    expect(
      (
        await verifyIdentityPassword(wrapped, {
          identityCode: "12345678",
          password: undefined,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await verifyIdentityPassword(env, {
          identityCode: "12345678",
          password: undefined,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await verifyIdentityPassword(wrapped, {
          identityCode: "12345678",
          password: "wrong",
        })
      ).ok,
    ).toBe(false);
    const crossSite = await withIdentityRequestSession(
      req("/api/public/vote", {
        method: "POST",
        headers: { cookie, origin: "https://evil.example" },
      }),
      env,
    );
    expect(
      (
        await verifyIdentityPassword(crossSite, {
          identityCode: "12345678",
          password: undefined,
        })
      ).ok,
    ).toBe(false);
  });
});

describe("protected integrated chat", () => {
  it("protects documents, bundles, APIs and files, ignoring forged bearer tokens", async () => {
    for (const path of [
      "/chat/",
      "/chat/assets/app.js",
      "/chat/api/bootstrap",
      "/chat/files/test",
    ]) {
      const response = await handleChat(
        req(path, { headers: { Authorization: `Bearer ${token}` } }),
        env,
      );
      expect([302, 401]).toContain(response.status);
    }
    expect(
      (await handleChat(req("/chat/", { headers: { cookie } }), env)).status,
    ).toBe(200);
  });
  it("keeps identity accounts ordinary and requires a separate OIDC or Key admin session", async () => {
    await bootstrap();
    expect(() =>
      sqlite
        .prepare("UPDATE users SET is_admin=1 WHERE identity_code_id='one'")
        .run(),
    ).toThrow();
    const response = await chatApp.request(
      req("/api/auth/session", {
        headers: {
          cookie,
          "x-cfchat-verified-is-admin": "1",
          "x-cfchat-internal-auth": "worker-verified",
        },
      }),
      undefined,
      env,
    );
    expect((await response.json()).session.isAdmin).toBe(false);
    const access = await requireAdmin(
      req("/api/admin/chat", { headers: { cookie } }),
      env,
      { api: true, permission: "admin:chat" },
    );
    expect(access.response.status).toBe(401);
    for (const path of ["/chat/admin", "/chat/admin/", "/chat/admin/users"]) {
      const blocked = await handleChat(req(path, { headers: { cookie } }), env);
      expect(blocked.status).toBe(404);
      expect(blocked.headers.has("Location")).toBe(false);
    }
    expect(
      (
        await handleChatAdmin(req("/api/admin/chat"), env, {
          ...admin,
          auth_method: "identity",
          permissions_json: '["*"]',
        })
      ).status,
    ).toBe(403);
    for (const auth_method of ["oidc", "temporary_key"]) {
      expect(
        (
          await handleChatAdmin(req("/api/admin/chat"), env, {
            ...admin,
            auth_method,
          })
        ).status,
      ).toBe(200);
    }
  });
  it("rejects cross-origin writes and websocket upgrades", () => {
    expect(
      identityRequestAllowed(
        req("/chat/api/upload", {
          method: "POST",
          headers: { cookie, origin: "https://evil.example" },
        }),
      ),
    ).toBe(false);
    expect(
      identityRequestAllowed(
        req("/chat/api/ws/public/1", {
          headers: {
            cookie,
            origin: "https://evil.example",
            upgrade: "websocket",
          },
        }),
      ),
    ).toBe(false);
    expect(
      identityRequestAllowed(
        req("/chat/api/ws/public/1", {
          headers: { cookie, origin, upgrade: "websocket" },
        }),
      ),
    ).toBe(true);
  });
  it("uses player names for display and @ names, keeping the same chat identity after changes", async () => {
    const payload = await (await bootstrap()).json();
    expect(payload.channels.find((c) => c.isGeneral)).toBeTruthy();
    const first = await validateSession(env, token);
    expect(first.session.username).toBe("雨梦");
    sqlite
      .prepare(
        "UPDATE identity_codes SET player_name='新名称',avatar_key='lifeafter/avatars/one/new.webp' WHERE id='one'",
      )
      .run();
    const second = await validateSession(env, token);
    expect(second.session.userId).toBe(first.session.userId);
    expect(second.session.username).toBe("新名称");
    // A fresh chat visit must also repair stale chat rows, even if they drifted independently.
    sqlite
      .prepare(
        "UPDATE users SET username='old-handle',display_name='旧昵称' WHERE identity_code_id='one'",
      )
      .run();
    const freshVisit = await chatApp.request(
      req("/api/auth/session", { headers: { cookie } }),
      undefined,
      env,
    );
    const current = (await freshVisit.json()).session;
    expect(current.username).toBe("新名称");
    expect(current.displayName).toBe("新名称");
    expect(current.userId).toBe(first.session.userId);
    const profile = await (
      await chatApp.request(
        req(`/api/users/${first.session.userId}/profile`, {
          headers: { cookie },
        }),
        undefined,
        env,
      )
    ).json();
    expect(profile.profile.displayName).toBe("新名称");
    expect(profile.profile.username).toBe("新名称");
    expect(profile.profile.avatarUrl).toContain(
      "/api/public/identity-avatar/one",
    );
    expect(profile.profile.email).toBe("");
  });
  it("has no chat login, OIDC, profile editing, Telegram or separate admin APIs", async () => {
    for (const [path, method] of [
      ["/api/auth/login", "POST"],
      ["/api/auth/oidc/config", "GET"],
      ["/api/me/profile", "PATCH"],
      ["/api/admin/channels", "GET"],
      ["/api/me/telegram-notifications", "GET"],
      ["/api/instance-bridge", "GET"],
    ]) {
      const response = await chatApp.request(
        req(path, { method, headers: jsonHeaders() }),
        undefined,
        env,
      );
      expect(response.status).toBe(404);
    }
  });
  it("denies private DM content and files to a non-member, allowing authorized camp admin reads", async () => {
    await bootstrap();
    await identity("two", "成员二", "22222222");
    await identity("three", "成员三", "33333333");
    await syncIdentityChatUsers(env);
    const one = sqlite
      .prepare("SELECT id FROM users WHERE identity_code_id='one'")
      .get().id;
    const two = sqlite
      .prepare("SELECT id FROM users WHERE identity_code_id='two'")
      .get().id;
    const three = sqlite
      .prepare("SELECT id FROM users WHERE identity_code_id='three'")
      .get().id;
    const room = sqlite
      .prepare(
        "INSERT INTO channels(name,kind,dm_key) VALUES('dm-secret','dm','two:three')",
      )
      .run().lastInsertRowid;
    sqlite
      .prepare(
        "INSERT INTO channel_members(channel_id,user_id) VALUES(?,?),(?,?)",
      )
      .run(room, two, room, three);
    const upload = await saveUploadedFile(
      { ...env, ...(await getChatPolicy(env)) },
      { userId: two },
      new File(["private attachment"], "private.txt", { type: "text/plain" }),
    );
    const message = await insertMessage(env, {
      channelId: Number(room),
      senderId: two,
      content: "私聊内容",
      mentionUserIds: [],
      attachment: upload.file,
    });
    expect([...objects.keys()][0]).toMatch(/^lifeafter\/chat\//);
    expect(
      (
        await handleChat(
          req("/chat/files/" + encodeURIComponent(upload.file.key), {
            headers: { cookie },
          }),
          env,
        )
      ).status,
    ).toBe(403);
    const ownerSession = await issueIdentitySession(env, req("/"), "22222222");
    const ownerCookie = ownerSession.cookie.split(";")[0];
    const owned = await handleChat(
      req("/chat/files/" + encodeURIComponent(upload.file.key), {
        headers: { cookie: ownerCookie },
      }),
      env,
    );
    expect(owned.status).toBe(200);
    expect(await owned.text()).toBe("private attachment");
    expect(
      sqlite.prepare("SELECT content FROM messages WHERE id=?").get(message.id)
        .content,
    ).not.toBe("私聊内容");
    expect(
      (
        await chatApp.request(
          req(`/api/messages?kind=dm&roomId=${room}`, { headers: { cookie } }),
          undefined,
          env,
        )
      ).status,
    ).toBe(403);
    const result = await handleChatAdmin(
      req(`/api/admin/chat/rooms/${room}/messages`),
      env,
      admin,
    );
    expect((await result.json()).messages[0].content).toBe("私聊内容");
    expect(
      (await handleChatAdmin(req("/api/admin/chat/audit"), env, admin)).status,
    ).toBe(404);
    expect(
      (
        await handleChatAdmin(req("/api/admin/chat"), env, {
          ...admin,
          permissions_json: '["admin:identity-codes"]',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await handleChatAdmin(req("/api/admin/chat"), env, {
          ...admin,
          permissions_json: '["demo:preview"]',
        })
      ).status,
    ).toBe(403);
    expect(one).not.toBe(two);
  });
});

describe("R2 avatars and backend-owned defaults", () => {
  it("stores validated cropped avatars under the configured prefix and shares them with chat", async () => {
    const file = new File(
      [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])],
      "avatar.png",
      { type: "image/png" },
    );
    const form = new FormData();
    form.append("file", file);
    const response = await handleIdentityAvatar(
      req("/api/public/identity-avatar", {
        method: "POST",
        headers: { cookie, origin },
        body: form,
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect([...objects.keys()][0]).toMatch(/^lifeafter\/avatars\/one\//);
    const url = (await response.json()).avatarUrl;
    expect(
      (await handleIdentityAvatar(req(url, { headers: { cookie } }), env))
        .status,
    ).toBe(200);
    expect((await handleIdentityAvatar(req(url), env)).status).toBe(401);
  });
  it("rejects forged image MIME types", async () => {
    const form = new FormData();
    form.append(
      "file",
      new File(["<svg>not an image</svg>"], "avatar.png", {
        type: "image/png",
      }),
    );
    expect(
      (
        await handleIdentityAvatar(
          req("/api/public/identity-avatar", {
            method: "POST",
            headers: { cookie, origin },
            body: form,
          }),
          env,
        )
      ).status,
    ).toBe(400);
    expect(objects.size).toBe(0);
  });
  it("persists policy in backend settings, overriding no Wrangler defaults", async () => {
    const defaults = await getChatPolicy(env);
    expect(defaults.MESSAGE_RETENTION_DAYS).toBe(7);
    expect(defaults.MAX_FILE_SIZE).toBe(20971520);
    env.MAX_FILE_SIZE = "1";
    expect((await getChatPolicy(env)).MAX_FILE_SIZE).toBe(20971520);
    const policy = {
      ...defaults,
      MESSAGE_RETENTION_DAYS: 14,
      MAX_FILE_SIZE: 1048576,
    };
    expect(
      (
        await handleChatAdmin(
          req("/api/admin/chat/policy", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(policy),
          }),
          env,
          admin,
        )
      ).status,
    ).toBe(200);
    expect(await getChatPolicy(env)).toEqual(policy);
    await expect(
      saveUploadedFile(
        { ...env, ...(await getChatPolicy(env)) },
        { userId: 1 },
        new File([new Uint8Array(1048577)], "large.txt", {
          type: "text/plain",
        }),
      ),
    ).rejects.toThrow("文件大小不能超过");
    expect(() =>
      validateChatPolicy({ ...policy, MAX_FILE_SIZE: -1 }),
    ).toThrow();
  });
  it("applies configured retention without querying removed OIDC/mobile/Telegram tables", async () => {
    await bootstrap();
    const sender = sqlite
      .prepare("SELECT id FROM users WHERE identity_code_id='one'")
      .get().id;
    sqlite
      .prepare(
        "INSERT INTO messages(channel_id,sender_id,content,created_at) VALUES(1,?,'old','2000-01-01')",
      )
      .run(sender);
    const result = await runScheduledGc({
      ...env,
      ...(await getChatPolicy(env)),
    });
    expect(result.expiredMessagesDeleted).toBe(1);
  });
});

describe("live identity directory and presence", () => {
  async function get(path) {
    return (
      await chatApp.request(req(path, { headers: { cookie } }), undefined, env)
    ).json();
  }
  function socket(userId, sessionToken = token, seenAt = Date.now()) {
    let attachment = {
      kind: DIRECTORY_MARKER,
      userId,
      token: sessionToken,
      seenAt,
    };
    return {
      readyState: 1,
      frames: [],
      close: vi.fn(function () {
        this.readyState = 3;
      }),
      send(value) {
        this.frames.push(JSON.parse(value));
      },
      deserializeAttachment: () => attachment,
      serializeAttachment(value) {
        attachment = value;
      },
    };
  }
  function directory(sockets) {
    const storage = {
      setAlarm: vi.fn(async () => {}),
      deleteAlarm: vi.fn(async () => {}),
      put: vi.fn(async () => {}),
    };
    return {
      directory: new IdentityDirectory(
        { getWebSockets: () => sockets, storage },
        env,
      ),
      storage,
    };
  }
  it("refreshes contacts and active group counts for new, disabled, expired and deleted identities without a new login", async () => {
    const first = await get("/api/bootstrap");
    const group = first.channels.find((c) => c.isGeneral).id;
    await identity("two", "新增成员", "22222222");
    expect(
      (await get("/api/contacts")).users.map((u) => u.displayName),
    ).toContain("新增成员");
    const members = await get(`/api/channels/${group}/members`);
    expect(members.members).toHaveLength(2);
    sqlite
      .prepare("UPDATE identity_codes SET status='disabled' WHERE id='two'")
      .run();
    expect((await get("/api/contacts")).users).toHaveLength(1);
    expect((await get(`/api/channels/${group}/members`)).members).toHaveLength(
      1,
    );
    expect(
      (await get("/api/bootstrap")).channels.find((c) => c.isGeneral)
        .memberCount,
    ).toBe(1);
    sqlite
      .prepare(
        "UPDATE identity_codes SET status='active',expires_at='2000-01-01T00:00:00Z' WHERE id='two'",
      )
      .run();
    expect((await get(`/api/channels/${group}/members`)).members).toHaveLength(
      1,
    );
    sqlite
      .prepare("UPDATE identity_codes SET expires_at=NULL WHERE id='two'")
      .run();
    expect((await get(`/api/channels/${group}/members`)).members).toHaveLength(
      2,
    );
    sqlite.prepare("DELETE FROM identity_codes WHERE id='two'").run();
    expect((await get("/api/contacts")).users).toHaveLength(1);
    expect((await get(`/api/channels/${group}/members`)).members).toHaveLength(
      1,
    );
  });
  it("keeps a member online across tabs, then removes revoked or expired connections and refreshes all observers", async () => {
    const viewer = (await validateSession(env, token)).session.userId;
    const watcher = socket(viewer);
    const savedCookie = cookie;
    await identity("two", "成员二", "22222222");
    await login("22222222");
    const member = (await validateSession(env, token)).session.userId;
    const a = socket(member),
      b = socket(member);
    const live = directory([watcher, a, b]);
    cookie = savedCookie;
    await live.directory.refresh();
    expect(watcher.frames.at(-1).onlineUserIds).toEqual([viewer, member]);
    await live.directory.disconnect(a);
    expect(watcher.frames.at(-1).onlineUserIds).toEqual([viewer, member]);
    sqlite
      .prepare("UPDATE identity_codes SET status='disabled' WHERE id='two'")
      .run();
    await live.directory.refresh(true);
    expect(b.close).toHaveBeenCalledWith(1008, "Identity session expired");
    expect(watcher.frames.at(-1).onlineUserIds).toEqual([viewer]);
    expect(watcher.frames.at(-1).directoryChanged).toBe(true);
    expect(JSON.stringify(watcher.frames.at(-1))).not.toContain(token);
    await live.directory.disconnect(watcher);
    expect(live.storage.deleteAlarm).toHaveBeenCalled();
  });
  it("wakes at identity expiry and detects members becoming invalid even without an admin request", async () => {
    const id = (await validateSession(env, token)).session.userId;
    const watcher = socket(id);
    await identity("two", "成员二", "22222222");
    const expires = new Date(Date.now() + 10_000).toISOString();
    sqlite
      .prepare("UPDATE identity_codes SET expires_at=? WHERE id='two'")
      .run(expires);
    const live = directory([watcher]);
    await live.directory.refresh();
    expect(live.storage.setAlarm.mock.calls.at(-1)[0]).toBeLessThanOrEqual(
      Date.parse(expires) + 100,
    );
    await live.directory.refresh();
    expect(watcher.frames.at(-1).directoryChanged).toBe(false);
    sqlite
      .prepare(
        "UPDATE identity_codes SET expires_at='2000-01-01' WHERE id='two'",
      )
      .run();
    await live.directory.refresh();
    expect(watcher.frames.at(-1).directoryChanged).toBe(true);
    expect(watcher.frames.at(-1).onlineUserIds).toEqual([id]);
  });
  it("restores presence after hibernation, ignores client-supplied identities, and expires lost heartbeats", async () => {
    const id = (await validateSession(env, token)).session.userId;
    const watcher = socket(id);
    const lost = socket(id, token, Date.now() - 76_000);
    const live = directory([watcher, lost]);
    await live.directory.refresh();
    expect(lost.close).toHaveBeenCalledWith(1001, "Presence heartbeat expired");
    await live.directory.webSocketMessage(
      watcher,
      JSON.stringify({ type: "directory_changed", onlineUserIds: [999] }),
    );
    await live.directory.webSocketMessage(watcher, "null");
    await live.directory.webSocketMessage(
      watcher,
      JSON.stringify({ type: "ping", userId: 999 }),
    );
    expect(watcher.deserializeAttachment().userId).toBe(id);
    await live.directory.refresh();
    expect(watcher.frames.at(-1).onlineUserIds).toEqual([id]);
    expect(
      (await live.directory.fetch(req("/directory/change", { method: "POST" })))
        .status,
    ).toBe(401);
  });
  it("invalidates only after successful mutations and uses the internal directory binding", async () => {
    for (const path of [
      "/api/admin/identity-codes/new",
      "/api/admin/identity-applications/new/approve",
      "/api/public/identity-cancellation",
      "/api/public/identity-avatar",
      "/api/public/identity-password-change",
      "/api/public/identity-session",
      "/chat/api/channels/1/members",
    ]) {
      expect(
        chatDirectoryMutation(
          req(path, { method: "POST" }),
          new Response("{}"),
        ),
      ).toBe(true);
      expect(chatDirectoryMutation(req(path), new Response("{}"))).toBe(false);
      expect(
        chatDirectoryMutation(
          req(path, { method: "POST" }),
          new Response("{}", { status: 400 }),
        ),
      ).toBe(false);
    }
    const fetch = vi.fn(async () => new Response("{}"));
    env.USER_INBOX = { getByName: vi.fn(() => ({ fetch })) };
    await notifyChatDirectory(env);
    expect(env.USER_INBOX.getByName).toHaveBeenCalledWith("identity-roster");
    expect(fetch.mock.calls[0][1].headers["x-cfchat-internal-auth"]).toBe(
      "worker-verified",
    );
  });
});

describe("authenticated password changes", () => {
  const change = (body, headers = jsonHeaders()) =>
    handleIdentityPasswordChange(
      req("/api/public/identity-password-change", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
      env,
    );
  it("requires the old password, binds its proof to the current login, and signs out every device after a successful change", async () => {
    const firstToken = token;
    expect(
      (await change({ action: "verify", oldPassword: "incorrect" })).status,
    ).toBe(400);
    expect(
      (await change({ action: "set", newPassword: "new-test-password" }))
        .status,
    ).toBe(400);
    const proof = (
      await (
        await change({ action: "verify", oldPassword: "test-password" })
      ).json()
    ).verificationToken;
    const firstCookie = cookie;
    await login();
    expect(
      (
        await change({
          action: "set",
          verificationToken: proof,
          newPassword: "new-test-password",
        })
      ).status,
    ).toBe(400);
    const secondToken = token;
    cookie = firstCookie;
    expect(
      (
        await change({
          action: "set",
          verificationToken: proof,
          newPassword: "test-password",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await change({
          action: "set",
          verificationToken: proof,
          newPassword: "short",
        })
      ).status,
    ).toBe(400);
    const result = await change({
      action: "set",
      verificationToken: proof,
      newPassword: "new-test-password",
    });
    expect(result.status).toBe(200);
    expect(result.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(await validateIdentitySession(env, firstToken)).toBeNull();
    expect(await validateIdentitySession(env, secondToken)).toBeNull();
    expect(
      sqlite.prepare("SELECT count(*) n FROM identity_web_sessions").get().n,
    ).toBe(0);
    const hash = sqlite
      .prepare("SELECT password_hash FROM identity_codes WHERE id='one'")
      .get().password_hash;
    expect(await verifyPassword("new-test-password", hash)).toBe(true);
    expect(await verifyPassword("test-password", hash)).toBe(false);
    expect(
      (
        await change({
          action: "set",
          verificationToken: proof,
          newPassword: "another-password",
        })
      ).status,
    ).toBe(401);
  });
  it("rejects guests, cross-origin requests, expired proofs and passwords after the identity expires", async () => {
    expect(
      (
        await change(
          { action: "verify", oldPassword: "test-password" },
          { origin },
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await change(
          { action: "verify", oldPassword: "test-password" },
          { cookie, origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
    const proof = (
      await (
        await change({ action: "verify", oldPassword: "test-password" })
      ).json()
    ).verificationToken;
    expect(
      (
        await change({
          action: "set",
          verificationToken: `1.${proof.split(".")[1]}`,
          newPassword: "new-password",
        })
      ).status,
    ).toBe(400);
    sqlite
      .prepare(
        "UPDATE identity_codes SET expires_at='2000-01-01' WHERE id='one'",
      )
      .run();
    expect(
      (
        await change({
          action: "set",
          verificationToken: proof,
          newPassword: "new-password",
        })
      ).status,
    ).toBe(401);
  });
  it("limits repeated old-password guesses per identity", async () => {
    for (let attempt = 0; attempt < 5; attempt++)
      expect(
        (await change({ action: "verify", oldPassword: "wrong" })).status,
      ).toBe(400);
    const response = await change({
      action: "verify",
      oldPassword: "test-password",
    });
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});

describe("authorized latest conversation messages", () => {
  async function get(path) {
    return (
      await chatApp.request(req(path, { headers: { cookie } }), undefined, env)
    ).json();
  }
  it("decrypts latest group and DM previews on bootstrap, and falls back after deleting the newest message", async () => {
    const group = (await get("/api/bootstrap")).channels.find(
      (c) => c.isGeneral,
    );
    const one = (await validateSession(env, token)).session.userId;
    await identity("two", "成员二", "22222222");
    await syncIdentityChatUsers(env);
    const two = sqlite
      .prepare("SELECT id FROM users WHERE identity_code_id='two'")
      .get().id;
    const dm = await ensureDmChannel(env.DB, one, two);
    const first = await insertMessage(env, {
      channelId: group.id,
      senderId: one,
      content: "群聊旧消息",
      mentionUserIds: [],
    });
    const latest = await insertMessage(env, {
      channelId: group.id,
      senderId: one,
      content: "群聊最新消息",
      mentionUserIds: [],
    });
    await insertMessage(env, {
      channelId: Number(dm.id),
      senderId: two,
      content: "新私聊消息",
      mentionUserIds: [],
    });
    const payload = await get("/api/bootstrap");
    expect(payload.channels.find((c) => c.isGeneral).lastMessage.content).toBe(
      "群聊最新消息",
    );
    expect(
      payload.dms.find((c) => c.id === Number(dm.id)).lastMessage.content,
    ).toBe("新私聊消息");
    expect((await get("/api/dm")).dms[0].lastMessage.content).toBe(
      "新私聊消息",
    );
    expect(
      sqlite.prepare("SELECT content FROM messages WHERE id=?").get(latest.id)
        .content,
    ).not.toBe("群聊最新消息");
    sqlite
      .prepare("UPDATE messages SET deleted_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(latest.id);
    expect(
      (await get("/api/bootstrap")).channels.find((c) => c.isGeneral)
        .lastMessage.id,
    ).toBe(first.id);
    sqlite
      .prepare("UPDATE messages SET deleted_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(first.id);
    expect(
      (await get("/api/bootstrap")).channels.find((c) => c.isGeneral)
        .lastMessage,
    ).toBeNull();
  });
  it("does not expose private or unjoined group previews to non-members", async () => {
    await bootstrap();
    const one = (await validateSession(env, token)).session.userId;
    await identity("two", "成员二", "22222222");
    await syncIdentityChatUsers(env);
    const two = sqlite
      .prepare("SELECT id FROM users WHERE identity_code_id='two'")
      .get().id;
    for (const kind of ["private", "public"]) {
      const room = sqlite
        .prepare("INSERT INTO channels(name,kind,created_by) VALUES(?,?,?)")
        .run("hidden-" + kind, kind, two).lastInsertRowid;
      sqlite
        .prepare(
          "INSERT INTO channel_members(channel_id,user_id,role) VALUES(?,?,?)",
        )
        .run(Number(room), two, "owner");
      await insertMessage(env, {
        channelId: Number(room),
        senderId: two,
        content: "不应泄露的消息",
        mentionUserIds: [],
      });
      const result = await attachConversationPreviews(
        env,
        [{ id: Number(room), kind, isMember: true }],
        one,
      );
      expect(result[0].lastMessage).toBeNull();
    }
    const payload = await get("/api/bootstrap");
    expect(
      payload.channels.find((c) => c.name === "hidden-private"),
    ).toBeUndefined();
    expect(
      payload.channels.find((c) => c.name === "hidden-public").lastMessage,
    ).toBeNull();
    expect(JSON.stringify(payload)).not.toContain("不应泄露的消息");
  });
  it("projects attachment-only latest messages without exposing file contents", async () => {
    const group = (await get("/api/bootstrap")).channels.find(
      (c) => c.isGeneral,
    );
    const one = (await validateSession(env, token)).session.userId;
    const upload = await saveUploadedFile(
      { ...env, ...(await getChatPolicy(env)) },
      { userId: one },
      new File(["private file bytes"], "report.txt", { type: "text/plain" }),
    );
    await insertMessage(env, {
      channelId: group.id,
      senderId: one,
      content: "",
      mentionUserIds: [],
      attachment: upload.file,
    });
    const preview = (await get("/api/bootstrap")).channels.find(
      (c) => c.isGeneral,
    ).lastMessage;
    expect(preview.attachment.name).toBe("report.txt");
    expect(preview.content).toBe("");
    expect(JSON.stringify(preview)).not.toContain("private file bytes");
  });
});

describe("chat admin message counts", () => {
  it("returns current room and overall counts after deletion, without counting the message twice", async () => {
    await bootstrap();
    const one = (await validateSession(env, token)).session.userId;
    const group = sqlite
      .prepare("SELECT id FROM channels WHERE name='general'")
      .get().id;
    await insertMessage(env, {
      channelId: group,
      senderId: one,
      content: "keep message",
      mentionUserIds: [],
    });
    const deleted = await insertMessage(env, {
      channelId: group,
      senderId: one,
      content: "delete message",
      mentionUserIds: [],
    });
    const detail = async () =>
      (
        await handleChatAdmin(
          req(`/api/admin/chat/rooms/${group}/messages`),
          env,
          admin,
        )
      ).json();
    expect((await detail()).room).toMatchObject({
      messageCount: 2,
      totalMessageCount: 2,
    });
    expect(
      (
        await handleChatAdmin(
          req(`/api/admin/chat/rooms/${group}/messages/${deleted.id}`, {
            method: "DELETE",
          }),
          env,
          admin,
        )
      ).status,
    ).toBe(200);
    const result = await detail();
    expect(result.room).toMatchObject({
      messageCount: 1,
      totalMessageCount: 1,
    });
    expect(result.messages).toHaveLength(1);
    expect(
      (
        await handleChatAdmin(
          req(`/api/admin/chat/rooms/${group}/messages/${deleted.id}`, {
            method: "DELETE",
          }),
          env,
          admin,
        )
      ).status,
    ).toBe(404);
    expect((await detail()).room).toMatchObject({
      messageCount: 1,
      totalMessageCount: 1,
    });
  });
});
