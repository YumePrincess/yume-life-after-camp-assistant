// Shared member-name acceptance rule for the member, contribution and
// activity tables. OCR confidence decides whether text is retained; this
// rule decides whether the retained text can be a display name.
export function isPlausibleMemberName(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 24) return false;
  if (/[\u3400-\u9fff]/u.test(text)) return true;
  if (/[\p{L}\p{N}]/u.test(text)) return false;
  // Some players use emoji or punctuation-only display names. Do not drop
  // those, but still reject empty/whitespace OCR fragments.
  return /[\p{S}\p{P}]/u.test(text);
}
