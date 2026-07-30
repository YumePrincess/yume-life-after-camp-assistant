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

const IDENTITY_RENEWAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function isIdentityRenewalWindowOpen(
  expiresAt: string | null,
  currentTime = Date.now()
): boolean {
  if (!expiresAt) return false;
  const expiry = Date.parse(expiresAt);
  return Number.isFinite(expiry) && expiry <= currentTime + IDENTITY_RENEWAL_WINDOW_MS;
}
