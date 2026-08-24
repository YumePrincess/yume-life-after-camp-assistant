// Shared member-name acceptance rule for the member, contribution and
// activity tables. OCR confidence decides whether text is retained; this
// rule decides whether the retained text can be a display name.
export function isMemberAvatarArtifact(value) {
  const text = String(value || "")
    .trim()
    .normalize("NFKC")
    .replace(/\s+/g, "");
  if (!text || text.length > 8) return false;

  // The avatar cards contain a printed year. Vision can return it as digits
  // (2025/20251), a letter-digit confusion (D025/O025), or a mixed glyph
  // confusion (2O25). Keep this narrow so real symbol-only names survive.
  const yearLike = text
    .replace(/^[dDoO]/u, "2")
    .replace(/[oO]/gu, "0")
    .replace(/[zZ]/gu, "2")
    .replace(/[sS]/gu, "5");
  return /^20\d{2,3}$/u.test(yearLike);
}

export function isMemberIdentityBadge(value) {
  const text = String(value || "")
    .trim()
    .normalize("NFKC")
    .replace(/\s+/g, "");
  // These are the small identity badges rendered after a player's name in
  // the member list. OCR may return the badge's label, its single-letter
  // glyph, or the full title; none is the player's name.
  return /^(?:启航|回归|先行者|R|®|ℝ)$/iu.test(text);
}

export function isMemberProfessionArtifact(value, profession) {
  const name = compact(value);
  const role = compact(profession);
  return Boolean(name && role && name === role);
}

export function isMemberSymbolOnlyName(value) {
  const text = String(value || "")
    .trim()
    .normalize("NFKC")
    .replace(/\s+/g, "");
  return Boolean(
    text &&
    !/[\u3400-\u9fff\p{L}\p{N}]/u.test(text) &&
    /[\p{S}\p{P}\p{M}]/u.test(text)
  );
}

export function isPlausibleMemberName(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 24) return false;
  if (isMemberAvatarArtifact(text)) return false;
  if (/[\u3400-\u9fff]/u.test(text)) return true;
  if (/[\p{L}\p{N}]/u.test(text)) return false;
  // Some players use emoji or punctuation-only display names. Do not drop
  // those, but still reject empty/whitespace OCR fragments.
  return /[\p{S}\p{P}\p{M}]/u.test(text);
}

function compact(value) {
  return String(value || "")
    .trim()
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .toLocaleLowerCase();
}
