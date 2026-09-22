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

  // OCR commonly turns boundary decorations into ASCII look-alikes, for
  // example `•简微O` versus the identity-code display name `〇简微〇`, or a
  // vertical decoration being read as `I`, `l` or `1`. Treat these as the
  // same only when the glyphs form a boundary pair. A lone trailing O/I/l
  // in a normal name such as `AlphaO` remains meaningful and is not removed.
  const boundaryDecoration = /[•·∙⋅‧●○◯〇⭕⚪⚫◉◎⊙⭘o0il1丨|❘❙]/u;
  // `⭕️` contains a variation selector after the visible circle. It is a
  // rendering hint, not part of the player name, so ignore it for the
  // boundary-pair check and the final comparison key.
  const characters = Array.from(
    normalized.replace(/[\uFE0E\uFE0F]/gu, "")
  );
  if (
    characters.length >= 3 &&
    boundaryDecoration.test(characters[0] ?? "") &&
    boundaryDecoration.test(characters.at(-1) ?? "")
  ) {
    characters.shift();
    characters.pop();
  }
  const withoutDecorativeCharacters = characters.join("").replace(
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
