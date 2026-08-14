// Player names are display strings, not identifiers. Keep the characters that
// are visible in the game while normalizing glyph variants that are visually
// indistinguishable to a human reader.
const VISUAL_LOOKALIKE_MAP = new Map([
  ["А", "A"],
  ["а", "a"]
]);

const NON_BREAKING_SPACES = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/gu;
const ZERO_WIDTH_SPACES = /[\u200b\u200c\u200d\ufeff]/gu;
// Text is authoritative. These punctuation characters are retained as small
// pieces of auxiliary name evidence; decorative Unicode symbols are handled
// separately and never allowed to replace a missing text character.
const SIMPLE_PLAYER_PUNCTUATION = new Set([
  "#",
  "-",
  "_",
  ".",
  "·",
  "・",
  "'",
  "’",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "「",
  "」",
  "『",
  "』",
  "【",
  "】",
  "《",
  "》",
  "〈",
  "〉",
  "※"
]);
const OCR_ARTIFACT_SYMBOLS = new Set([
  "&",
  "/",
  "\\",
  "¥",
  "￥",
  "\"",
  "“",
  "”",
  "‘",
  "’",
  "!",
  "！"
]);
const NON_NAME_MARKERS = new Set([
  "回归",
  "回归玩家",
  "先行者",
  "市长"
]);
const AVATAR_YEAR_PATTERN = /^2025\d*$/u;
const REPEATED_DASH_PATTERN = /^(?:[-_–—=·・]\s*){4,}$/u;
const VISUAL_SYMBOL_DESCRIPTIONS = new Map([
  ["✨", "繁星"],
  ["★", "实心星"],
  ["☆", "空心星"],
  ["✿", "实心花"],
  ["❀", "空心花"],
  ["❁", "双层花"],
  ["❉", "六瓣花"],
  ["❃", "花饰"],
  ["✲", "星花"],
  ["♠", "黑桃"],
  ["♤", "白桃"],
  ["☻", "实心笑脸"],
  ["😊", "笑脸"],
  ["❤", "红心"],
  ["დღ", "დღ字形符号"]
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

export function normalizePlayerOcrArtifact(value) {
  // Keep OCR spelling lossless here. Visual symbol classification and
  // row-level recovery decide whether a glyph is decorative; this generic
  // normalizer must never contain roster-specific aliases.
  return normalizeVisualName(value);
}

export function normalizeMemberCampTitle(value) {
  const raw = normalizeVisualName(value)
    .replace(/^#?(?:B|D|G|K|O|P|R|U|W|Y)\s*/u, "")
    .trim();
  if (!raw) return "";
  const text = Array.from(raw)
    .filter(
      (character) =>
        /[\p{L}\p{N}]/u.test(character) || /\s/u.test(character)
    )
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  // A one-glyph title is overwhelmingly a clipped neighboring name or a
  // classifier artifact in this two-line member layout. Real role/title
  // labels such as 市长、启航、春之音 are at least two text glyphs.
  return Array.from(text).filter((character) => /[\p{L}\p{N}]/u.test(character)).length >= 2
    ? text
    : "";
}

function isPlayerTextCharacter(character) {
  return /[\p{L}\p{N}]/u.test(character);
}

function isSimplePlayerPunctuation(character) {
  return SIMPLE_PLAYER_PUNCTUATION.has(character);
}

/**
 * Normalize a name for task execution. OCR is allowed to return decorative
 * glyphs, but they must not become player identity data by default. Chinese,
 * Japanese, Latin letters (including French accents), numbers, spaces and a
 * small explicit punctuation allow-list remain. A symbol-only display name
 * is retained as a last-resort candidate because it has no text fallback.
 */
export function normalizePlayerName(value, options = {}) {
  const raw = normalizePlayerOcrArtifact(value);
  if (!raw) return "";
  if (options.preserveSymbols) return normalizeAuxiliaryPlayerName(raw);

  const characters = Array.from(raw);
  const hasText = characters.some(isPlayerTextCharacter);
  if (!hasText) return normalizeAuxiliaryPlayerName(raw);

  const normalized = characters
    .filter(
      (character) =>
        isPlayerTextCharacter(character) ||
        /\s/u.test(character) ||
        isSimplePlayerPunctuation(character)
    )
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  // A detached dash is usually a badge/texture fragment. Keep punctuation
  // inside text (A-B, #Yume), but do not turn `- 容墨轩` into a new spelling.
  return trimDetachedNamePunctuation(normalized);
}

// Compatibility export for plugins written against the previous classifier.
// Symbols remain auxiliary evidence, never the canonical text spelling.
export function normalizePlayerNameVariant(value) {
  return normalizeAuxiliaryPlayerName(value);
}

export function playerNameTextKey(value) {
  const raw = normalizePlayerOcrArtifact(value).toLocaleLowerCase();
  const text = Array.from(raw).filter(isPlayerTextCharacter).join("");
  return text || normalizePlayerName(raw).replace(/\s+/gu, " ");
}

export function playerNameHasText(value) {
  return Array.from(normalizeVisualName(value)).some(isPlayerTextCharacter);
}

export function isAvatarYearText(value) {
  return AVATAR_YEAR_PATTERN.test(
    normalizeVisualName(value).replace(/\s+/gu, "")
  );
}

export function isRepeatedDashArtifact(value) {
  return REPEATED_DASH_PATTERN.test(normalizeVisualName(value));
}

export function normalizeMemberIdentityName(value) {
  const raw = normalizeVisualName(value);
  if (!raw || isAvatarYearText(raw)) return "";
  // Legacy/plugin OCR can merge the printed avatar year into the first name
  // token. This is deliberately scoped to identity parsing, so a legitimate
  // contribution value of 2025 is never removed from numeric columns.
  const withoutAvatarPrefix = raw
    .replace(/^2025\d*\s+/u, "")
    .replace(/^2025\d*(?=[\p{L}\p{N}])/u, "");
  if (isRepeatedDashArtifact(withoutAvatarPrefix)) return "";
  return normalizePlayerName(withoutAvatarPrefix);
}

export function stripStackedCampTitleFromName(value, campTitle) {
  const raw = normalizeVisualName(value);
  const title = normalizeMemberCampTitle(campTitle);
  if (!raw || !title) return raw;
  const colorPrefix = raw.match(/^#?(?:B|D|G|K|O|P|R|U|W|Y)/u)?.[0] || "";
  if (!colorPrefix || !raw.startsWith(`${colorPrefix}${title}`)) return raw;
  // Vision may merge the colored second line with the first line into one
  // observation, e.g. `#U夏之虹星河踏月归`. The row's independently inferred
  // campTitle is the only safe boundary: remove that colored title prefix,
  // never a roster-specific alias or a guessed player-name substring.
  return raw.slice(colorPrefix.length + title.length).trim();
}

export function memberRowDataKey(row) {
  const fields = [
    "weeklyContribution",
    "profession",
    "roommateName",
    "manorLevel",
    "campTitle"
  ];
  return fields
    .map((field) => {
      const value = row?.[field];
      if (value === null || value === undefined || String(value).trim() === "") {
        return "";
      }
      return `${field}=${String(value).normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim()}`;
    })
    .filter(Boolean)
    .join("|");
}

export function describePlayerName(value) {
  const raw = normalizeAuxiliaryPlayerName(value);
  if (!raw) return "";
  const text = normalizeMemberIdentityName(raw);
  const symbols = [...new Set(
    Array.from(raw).filter(
      (character) =>
        !isPlayerTextCharacter(character) &&
        !/\s/u.test(character) &&
        !isSimplePlayerPunctuation(character)
    )
  )];
  if (!symbols.length) return text || raw;
  const description = symbols
    .map((symbol) => VISUAL_SYMBOL_DESCRIPTIONS.get(symbol) || `符号${symbol}`)
    .join("、");
  return text ? `${text}（${description}）` : `（${description}）`;
}

export function playerNameSymbolSignature(value) {
  return Array.from(normalizeVisualName(value))
    .filter(
      (character) =>
        !isPlayerTextCharacter(character) && !/\s/u.test(character)
    )
    .join("");
}

export function normalizePlayerNameRows(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    const rawName = normalizePlayerOcrArtifact(row?.rawName || row?.name);
    const normalizedName = normalizeMemberIdentityName(rawName);
    if (!normalizedName && !isRecognizableSymbolOnlyName(rawName)) continue;
    const key = playerNameTextKey(rawName);
    if (!key) continue;
    const group = groups.get(key) || [];
    group.push({ ...row, rawName });
    groups.set(key, group);
  }
  return [...groups.values()].flatMap((group) => {
    const byAuxiliaryName = new Map();
    for (const row of group) {
      // The auxiliary glyphs are the only safe discriminator when text is
      // identical. Repeated OCR reads of the same glyph spelling are merged;
      // rows with a different auxiliary spelling remain separate even when
      // their contribution/profession values happen to be equal.
      const auxiliaryName = normalizeAuxiliaryPlayerName(row.rawName);
      const key = auxiliaryName || normalizeMemberIdentityName(row.rawName);
      const previous = byAuxiliaryName.get(key);
      byAuxiliaryName.set(
        key,
        previous ? mergeMemberProfileRows(previous, row) : row
      );
    }
    const variants = [...byAuxiliaryName.values()];
    if (variants.length === 1) {
      const row = variants[0];
      return [{
        ...row,
        name: normalizeMemberIdentityName(row.rawName || row.name),
        rawName: row.rawName || normalizeVisualName(row.name)
      }];
    }
    const auxiliaryNames = variants.map((row) =>
      normalizePlayerNameVariant(row.rawName || row.name)
    );
    const hasDistinctAuxiliaryNames =
      auxiliaryNames.every(Boolean) &&
      new Set(auxiliaryNames).size === auxiliaryNames.length;
    return variants.map((row, index) => ({
      ...row,
      // Same text + conflicting row evidence means two real symbol variants.
      // Preserve the auxiliary glyphs only in this collision branch; ordinary
      // names remain text-first and symbol-free.
      name: hasDistinctAuxiliaryNames
        ? auxiliaryNames[index]
        : normalizeMemberIdentityName(row.rawName || row.name),
      rawName: row.rawName || normalizeVisualName(row.name),
      __preserveNameSymbols: hasDistinctAuxiliaryNames
    }));
  });
}

function normalizeAuxiliaryPlayerName(value) {
  const raw = normalizeVisualName(value);
  if (!raw || isRepeatedDashArtifact(raw) || isAvatarYearText(raw)) return "";
  const characters = Array.from(raw);
  if (characters.some(isPlayerTextCharacter)) {
    return trimDetachedNamePunctuation(
      characters
        .filter(
          (character) =>
            isPlayerTextCharacter(character) ||
            /\s/u.test(character) ||
            isSimplePlayerPunctuation(character) ||
            character === "※" ||
            /\p{M}/u.test(character) ||
            (!OCR_ARTIFACT_SYMBOLS.has(character) && /[\p{S}]/u.test(character))
        )
        .join("")
        .replace(/\s+/gu, " ")
        .trim()
    );
  }
  return isRecognizableSymbolOnlyName(raw) ? raw : "";
}

function isRecognizableSymbolOnlyName(value) {
  const raw = normalizeVisualName(value);
  if (!raw || isRepeatedDashArtifact(raw) || isAvatarYearText(raw)) return false;
  const characters = Array.from(raw).filter((character) => !/\s/u.test(character));
  if (!characters.length || characters.every((character) => SIMPLE_PLAYER_PUNCTUATION.has(character))) {
    if (/^[「『].*[」』]$/u.test(raw)) return true;
    return false;
  }
  return characters.some(
    (character) =>
      !OCR_ARTIFACT_SYMBOLS.has(character) &&
      (/\p{S}/u.test(character) || /\p{P}/u.test(character))
  );
}

function trimDetachedNamePunctuation(value) {
  let text = String(value || "").trim();
  text = text.replace(/^(?:[-_–—=·・]\s+)+/u, "");
  text = text.replace(/(?:\s+[-_–—=·・])+$/u, "");
  return text.trim();
}

function mergeMemberProfileRows(current, incoming) {
  const merged = { ...current };
  for (const [key, value] of Object.entries(incoming || {})) {
    if (value !== null && value !== undefined && String(value).trim()) {
      merged[key] = value;
    }
  }
  return merged;
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
  const textCharacterCount = (value) =>
    Array.from(normalizeVisualName(value)).filter(isPlayerTextCharacter).length;
  const lineTextCount = visible.reduce(
    (count, item) => count + textCharacterCount(item?.text),
    0
  );
  let previousRight = null;
  let result = "";
  for (const [index, item] of visible.entries()) {
    const left = Number(item?.x) || 0;
    const right = left + (Number(item?.width) || 0);
    const gap = previousRight == null ? 0 : left - previousRight;
    const itemText = normalizeVisualName(item?.text);
    const singleLatinBadge =
      lineTextCount >= 2 &&
      /^[A-Za-z]$/u.test(itemText) &&
      index === visible.length - 1 &&
      gap > medianHeight * 0.55;
    const detachedSingleTextArtifact =
      lineTextCount >= 3 &&
      index === visible.length - 1 &&
      gap > medianHeight * 0.7 &&
      Array.from(itemText).length <= 1 &&
      Array.from(itemText).some(isPlayerTextCharacter);
    // The game places returning-player/pioneer/mayor glyphs immediately to
    // the right of the name. Vision can turn one of those isolated glyphs
    // into a Latin letter. A detached one-letter tail on an otherwise
    // text-bearing name is a generic badge artifact, not a second line or a
    // part of the player name. Do not apply this to symbol-only names: their
    // spacing is the identity data we are trying to preserve.
    if (singleLatinBadge || detachedSingleTextArtifact) continue;
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
  const nameY = Number(nameLine?.y || 0);
  const nameLeft = Number(nameLine?.x || 0);
  const nameHeight = Math.max(0, Number(nameLine?.height || 0));
  const secondLineOffset = Math.max(8, nameHeight * 0.55);
  const titleLeftTolerance = Math.max(
    18,
    nameHeight * 1.5,
    (Number(nameLine?.width) || 0) * 0.18
  );
  const campTitle = lines
    // A title is a vertically stacked line under the name. Same-baseline
    // observations are name-adjacent badges/artifacts and must never become
    // campTitle. This also prevents fallback symbol observations from being
    // serialized as a title when they came from the other columns.
    .filter(
      (item) =>
        item !== nameLine &&
        Number(item?.y || 0) >= nameY + secondLineOffset &&
        Math.abs((Number(item?.x) || 0) - nameLeft) <= titleLeftTolerance &&
        !isNonNameMarker(item.text)
    )
    .map((item) => normalizeVisualName(item.text))
    .filter(Boolean)
    .join(" ");
  return { name, campTitle: normalizeMemberCampTitle(campTitle) };
}
