import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("worker-mailer", () => ({ WorkerMailer: class {} }));
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { keyedHash, encryptSecret, hashPassword } from "../src/crypto";
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
  it("denies private DM content and files to a non-member, while recording authorized admin reads", async () => {
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
      sqlite
        .prepare(
          "SELECT actor FROM chat_admin_audit WHERE action='read_messages'",
        )
        .get().actor,
    ).toBe(admin.email);
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
