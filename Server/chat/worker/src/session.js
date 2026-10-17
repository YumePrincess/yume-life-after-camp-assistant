import {
  validateIdentitySession,
  identityAvatarUrl,
} from "../../../src/identity-session.ts";

export async function syncIdentityChatUsers(env) {
  await env.DB.prepare(`INSERT OR IGNORE INTO users(identity_code_id,username,display_name,password_hash,password_salt,avatar_url)
    SELECT id,COALESCE(NULLIF(player_name,''),'未命名成员'),COALESCE(NULLIF(player_name,''),'未命名成员'),'','',
      CASE WHEN avatar_key IS NOT NULL THEN '/api/public/identity-avatar/' || id || '?v=' || hex(avatar_key) ELSE '' END
    FROM identity_codes WHERE status = 'active' AND (expires_at IS NULL OR datetime(expires_at) > CURRENT_TIMESTAMP)`).run();
}

export async function validateSession(env, token) {
  const code = await validateIdentitySession(env, token || "");
  if (!code)
    return {
      ok: false,
      status: 401,
      message: "身份识别码登录已失效，请重新登录",
    };
  const name = code.player_name || "未命名成员";
  await env.DB.prepare(`INSERT INTO users(identity_code_id,username,display_name,password_hash,password_salt,avatar_url) VALUES(?,?,?,'','',?)
    ON CONFLICT(identity_code_id) DO UPDATE SET username=excluded.username,display_name=excluded.display_name,avatar_url=excluded.avatar_url
    WHERE users.deleted_at IS NULL AND (users.username != excluded.username OR users.display_name != excluded.display_name OR users.avatar_url != excluded.avatar_url)`)
    .bind(code.id, name, name, identityAvatarUrl(code))
    .run();
  const user = await env.DB.prepare(
    "SELECT id,username,display_name,avatar_url FROM users WHERE identity_code_id = ? AND deleted_at IS NULL",
  )
    .bind(code.id)
    .first();
  if (!user)
    return {
      ok: false,
      status: 401,
      message: "身份识别码登录已失效，请重新登录",
    };
  return {
    ok: true,
    session: {
      token,
      userId: Number(user.id),
      username: name,
      displayName: name,
      avatarUrl: identityAvatarUrl(code),
      bio: "",
      isAdmin: false,
      identityId: code.id,
      expiresAt: code.expires_at,
    },
  };
}
