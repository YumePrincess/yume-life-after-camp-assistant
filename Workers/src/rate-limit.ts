import { keyedHash } from "./crypto";

export interface RateLimitPolicy {
  scope: string;
  maximum: number;
  windowSeconds: number;
  blockSeconds: number;
}

export interface RateLimitState {
  allowed: boolean;
  retryAfterSeconds: number;
}

// Bound both the attempt window and lockout, including legacy rows persisted with longer expiries.
const MAX_RATE_LIMIT_PERIOD_SECONDS = 15 * 60;

function effectiveBlockSeconds(policy: RateLimitPolicy): number {
  return Math.max(1, Math.min(policy.blockSeconds, MAX_RATE_LIMIT_PERIOD_SECONDS));
}

function effectiveWindowSeconds(policy: RateLimitPolicy): number {
  return Math.max(1, Math.min(policy.windowSeconds, MAX_RATE_LIMIT_PERIOD_SECONDS));
}

async function requestIdentifier(
  request: Request,
  env: Env,
  scope: string
): Promise<string> {
  const address =
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
    "unknown";
  return keyedHash(env, "public-rate-limit", `${scope}:${address}`);
}

async function valueIdentifier(
  env: Env,
  scope: string,
  value: unknown
): Promise<string> {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : String(value ?? "");
  return keyedHash(env, "public-rate-limit-value", `${scope}:${normalized}`);
}

async function checkIdentifierRateLimit(
  key: string,
  env: Env,
  policy: RateLimitPolicy
): Promise<RateLimitState> {
  const row = await env.DB.prepare(
    `SELECT attempts, window_started_at, blocked_until
     FROM public_rate_limits WHERE identifier_hash = ?`
  )
    .bind(key)
    .first<{
      attempts: number;
      window_started_at: string;
      blocked_until: string | null;
    }>();
  if (!row) return { allowed: true, retryAfterSeconds: 0 };
  const timestamp = Date.now();
  let blockedUntil = row.blocked_until ? Date.parse(row.blocked_until) : 0;
  if (blockedUntil > timestamp) {
    const maximumBlockedUntil = timestamp + effectiveBlockSeconds(policy) * 1000;
    if (blockedUntil > maximumBlockedUntil) {
      blockedUntil = maximumBlockedUntil;
      await env.DB.prepare(
        `UPDATE public_rate_limits SET blocked_until = ?, updated_at = ?
         WHERE identifier_hash = ?`
      )
        .bind(
          new Date(blockedUntil).toISOString(),
          new Date(timestamp).toISOString(),
          key
        )
        .run();
    }
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((blockedUntil - timestamp) / 1000))
    };
  }
  const windowEnds = Date.parse(row.window_started_at) + effectiveWindowSeconds(policy) * 1000;
  if (row.attempts >= policy.maximum && windowEnds > timestamp) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((windowEnds - timestamp) / 1000))
    };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

async function recordIdentifierRateLimitAttempt(
  key: string,
  env: Env,
  policy: RateLimitPolicy
): Promise<RateLimitState> {
  const timestamp = new Date();
  const windowSeconds = effectiveWindowSeconds(policy);
  const current = await env.DB.prepare(
    `SELECT attempts, window_started_at FROM public_rate_limits
     WHERE identifier_hash = ?`
  )
    .bind(key)
    .first<{ attempts: number; window_started_at: string }>();
  const withinWindow =
    current &&
    Date.parse(current.window_started_at) + windowSeconds * 1000 >
      timestamp.getTime();
  const attempts = withinWindow ? current.attempts + 1 : 1;
  const windowStartedAt = withinWindow
    ? current.window_started_at
    : timestamp.toISOString();
  const blockedUntil =
    attempts >= policy.maximum
      ? new Date(
          timestamp.getTime() + effectiveBlockSeconds(policy) * 1000
        ).toISOString()
      : null;
  await env.DB.prepare(
    `INSERT INTO public_rate_limits(
      identifier_hash, scope, window_started_at, attempts, blocked_until, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(identifier_hash) DO UPDATE SET
      scope = excluded.scope,
      window_started_at = excluded.window_started_at,
      attempts = excluded.attempts,
      blocked_until = excluded.blocked_until,
      updated_at = excluded.updated_at`
  )
    .bind(
      key,
      policy.scope,
      windowStartedAt,
      attempts,
      blockedUntil,
      timestamp.toISOString()
    )
    .run();
  return blockedUntil
    ? { allowed: false, retryAfterSeconds: effectiveBlockSeconds(policy) }
    : { allowed: true, retryAfterSeconds: 0 };
}

async function clearIdentifierRateLimitAttempt(
  key: string,
  env: Env
): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM public_rate_limits WHERE identifier_hash = ?"
  )
    .bind(key)
    .run();
}

export async function checkRateLimit(
  request: Request,
  env: Env,
  policy: RateLimitPolicy
): Promise<RateLimitState> {
  return checkIdentifierRateLimit(
    await requestIdentifier(request, env, policy.scope),
    env,
    policy
  );
}

export async function recordRateLimitAttempt(
  request: Request,
  env: Env,
  policy: RateLimitPolicy
): Promise<RateLimitState> {
  return recordIdentifierRateLimitAttempt(
    await requestIdentifier(request, env, policy.scope),
    env,
    policy
  );
}

export async function clearRateLimitAttempts(
  request: Request,
  env: Env,
  policy: RateLimitPolicy
): Promise<void> {
  return clearIdentifierRateLimitAttempt(
    await requestIdentifier(request, env, policy.scope),
    env
  );
}

export async function checkValueRateLimit(
  value: unknown,
  env: Env,
  policy: RateLimitPolicy
): Promise<RateLimitState> {
  return checkIdentifierRateLimit(
    await valueIdentifier(env, policy.scope, value),
    env,
    policy
  );
}

export async function recordValueRateLimitAttempt(
  value: unknown,
  env: Env,
  policy: RateLimitPolicy
): Promise<RateLimitState> {
  return recordIdentifierRateLimitAttempt(
    await valueIdentifier(env, policy.scope, value),
    env,
    policy
  );
}

export async function clearValueRateLimitAttempts(
  value: unknown,
  env: Env,
  policy: RateLimitPolicy
): Promise<void> {
  return clearIdentifierRateLimitAttempt(
    await valueIdentifier(env, policy.scope, value),
    env
  );
}
