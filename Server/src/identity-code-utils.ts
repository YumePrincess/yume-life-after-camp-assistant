export function isSequentialIdentityCode(code: string): boolean {
  const digits = [...code].map(Number);
  const ascending = digits.every(
    (digit, index) => index === 0 || digit === ((digits[index - 1] ?? 0) + 1) % 10
  );
  const descending = digits.every(
    (digit, index) => index === 0 || digit === ((digits[index - 1] ?? 0) + 9) % 10
  );
  return ascending || descending;
}

export function identityPlayerNameKey(value: unknown): string {
  const normalized =
    typeof value === "string"
      ? value.normalize("NFKC").trim().toLocaleLowerCase()
      : "";
  const withoutDecorativeCharacters = normalized.replace(
    /[\p{P}\p{S}\s]+/gu,
    ""
  );
  return withoutDecorativeCharacters || normalized;
}

const IDENTITY_RENEWAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function isIdentityRenewalWindowOpen(
  expiresAt: string | null,
  currentTime = Date.now()
): boolean {
  if (!expiresAt) return false;
  const expiry = Date.parse(expiresAt);
  return Number.isFinite(expiry) && expiry <= currentTime + IDENTITY_RENEWAL_WINDOW_MS;
}

export function isIdentityCodeExpired(
  expiresAt: string | null,
  currentTime = Date.now()
): boolean {
  if (!expiresAt) return false;
  const expiry = Date.parse(expiresAt);
  return Number.isFinite(expiry) && expiry <= currentTime;
}

export function canUseExpiredRenewalGrace(input: {
  expiresAt: string | null;
  pendingRenewal: boolean;
  graceVoteUsedAt: string | null;
  currentTime?: number;
}): boolean {
  return (
    isIdentityCodeExpired(input.expiresAt, input.currentTime) &&
    input.pendingRenewal &&
    !input.graceVoteUsedAt
  );
}
