// Player names are display strings, not identifiers. Keep the characters that
// are visible in the game while normalizing glyph variants that are visually
// indistinguishable to a human reader.
const VISUAL_LOOKALIKE_MAP = new Map([
  ["А", "A"],
  ["а", "a"]
]);

const NON_BREAKING_SPACES = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/gu;
const ZERO_WIDTH_SPACES = /[\u200b\u200c\u200d\ufeff]/gu;
const NON_NAME_MARKERS = new Set([
  "回归",
  "回归玩家",
  "先行者",
  "市长"
]);

export function normalizeVisualName(value) {
  let text = String(value ?? "")
    .normalize("NFKC")
    .replace(NON_BREAKING_SPACES, " ")
    .replace(ZERO_WIDTH_SPACES, " ")
    .replace(/[\t\r\n]+/gu, " ");
  text = [...text].map((character) => VISUAL_LOOKALIKE_MAP.get(character) || character).join("");
  // The member list can merge the returning-player/pioneer badge with the
  // name box. In that case Vision commonly returns an ordinal/noise prefix
  // plus a quote/parenthesis suffix, for example `4纸鸢”)`. Strip only this
  // unmistakable badge pattern; ordinary digits and punctuation in names are
  // otherwise preserved byte-for-byte after visual normalization.
  if (
    /[”")）]$/u.test(text) &&
    /^[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/u.test(text)
  ) {
    text = text
      .replace(/^[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/u, "")
      .replace(/[0-9”")）]+$/u, "");
  }
  return text.replace(/^\s+|\s+$/gu, "");
}

export function isNonNameMarker(value) {
  const normalized = normalizeVisualName(value).replace(/\s+/gu, "");
  if (NON_NAME_MARKERS.has(normalized)) return true;
  return /^(?:回归|先行者|市长)(?:玩家|图标)?$/u.test(normalized);
}

export function reconstructVisualText(value, observation = {}) {
  const text = normalizeVisualName(value);
  if (!text) return "";
  // Vision often returns a wide box containing only the two corner brackets.
  // The empty visual span is meaningful in a player name, so recover it from
  // the measured glyph box instead of asking OCR to invent whitespace.
  if (text === "「」" || text === "『』") {
    const height = Math.max(1, Number(observation.height) || 0);
    const width = Math.max(0, Number(observation.width) || 0);
    if (!Number(observation.height) || !width) return text;
    const bracketWidth = height ? height * 0.82 : 0;
    const visualGap = width - bracketWidth * 2;
    const spaceWidth = height ? height * 0.62 : 0;
    if (visualGap > spaceWidth * 0.9) {
      const count = Math.max(1, Math.min(32, Math.round(visualGap / spaceWidth)));
      return `${text[0]}${" ".repeat(count)}${text[1]}`;
    }
  }
  return text;
}

export function joinVisualNameObservations(items) {
  const visible = (items || [])
    .filter((item) => !isNonNameMarker(item?.text))
    .sort((left, right) => Number(left?.x || 0) - Number(right?.x || 0));
  if (!visible.length) return "";
  const heights = visible
    .map((item) => Number(item?.height) || 0)
    .filter((height) => height > 0)
    .sort((left, right) => left - right);
  const medianHeight = heights[Math.floor(heights.length / 2)] || 20;
  const normalGap = medianHeight * 0.22;
  let previousRight = null;
  let result = "";
  for (const item of visible) {
    const left = Number(item?.x) || 0;
    const right = left + (Number(item?.width) || 0);
    const gap = previousRight == null ? 0 : left - previousRight;
    if (gap > normalGap && medianHeight > 0) {
    // A gap is measured between OCR boxes, so using glyph width directly
    // overestimates spaces for punctuation such as 「 」. The line height is
    // the stable visual unit across the game's proportional fonts.
    const spaces = Math.max(1, Math.min(32, Math.round((gap - normalGap) / medianHeight)));
      result += " ".repeat(spaces);
    }
    result += reconstructVisualText(item?.text, item);
    previousRight = Math.max(previousRight ?? right, right);
  }
  return normalizeVisualName(result);
}

export function normalizeIdentityLines(items) {
  const lines = (items || [])
    .flatMap((item) =>
      String(item?.text || "")
        .split(/\r?\n/u)
        .map((text, lineIndex) => ({
          ...item,
          text,
          y:
            (Number(item?.y) || 0) +
            lineIndex * Math.max(20, Number(item?.height) || 24)
        }))
    )
    .filter((item) => normalizeVisualName(item.text))
    .sort((left, right) => Number(left?.y || 0) - Number(right?.y || 0));
  if (!lines.length) return { name: "", campTitle: "" };
  const nameLine = lines.find((item) => !isNonNameMarker(item.text));
  if (!nameLine) return { name: "", campTitle: "" };
  const name = joinVisualNameObservations(
    lines.filter((item) => Math.abs(Number(item?.y || 0) - Number(nameLine?.y || 0)) <= Math.max(8, Number(nameLine?.height || 0) * 0.8))
  );
  const campTitle = lines
    .filter((item) => item !== nameLine && !isNonNameMarker(item.text))
    .map((item) => normalizeVisualName(item.text))
    .filter(Boolean)
    .join(" ");
  return { name, campTitle };
}
