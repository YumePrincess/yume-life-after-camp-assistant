import {
  isRepeatedDashArtifact,
  normalizePlayerName,
  playerNameHasText
} from "./visual-name.mjs";

// Shared member-name acceptance rule for the member, contribution and
// activity tables. OCR confidence decides whether text is retained; this
// rule decides whether the retained text can be a display name.
export function isPlausibleMemberName(value) {
  const text = normalizePlayerName(value);
  if (!text || text.length > 24) return false;
  // Chinese, Japanese, English and French names all reach this branch. Do
  // not reject Latin names as OCR noise: the roster is multilingual.
  if (/[\p{L}\p{N}]/u.test(text)) return true;
  // Keep a genuinely decorative symbol-only name as a last-resort candidate,
  // but never accept a background streak such as `--------` or a whitespace
  // separated dash run as a player. Symbols are auxiliary evidence, not a
  // license to turn texture into a roster entry.
  if (isRepeatedDashArtifact(text)) return false;
  return (
    !playerNameHasText(text) &&
    (/[\p{S}]/u.test(text) || /^[「『].*[」』]$/u.test(text))
  );
}
