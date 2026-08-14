import { normalizePlayerName } from "./visual-name.mjs";

// Shared member-name acceptance rule for the member, contribution and
// activity tables. OCR confidence decides whether text is retained; this
// rule decides whether the retained text can be a display name.
export function isPlausibleMemberName(value) {
  const text = normalizePlayerName(value);
  if (!text || text.length > 24) return false;
  // Chinese, Japanese, English and French names all reach this branch. Do
  // not reject Latin names as OCR noise: the roster is multilingual.
  if (/[\p{L}\p{N}]/u.test(text)) return true;
  // Symbol-only names have no text fallback. Keep them as candidates so the
  // profile roster can try to preserve and distinguish them later.
  return /[^\s]/u.test(text);
}
