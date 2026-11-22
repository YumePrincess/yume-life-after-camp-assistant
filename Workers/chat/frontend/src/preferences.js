const LANGUAGE_STORAGE = 'lang';
const THEME_STORAGE = 'yume-theme';

function readStorage(key) {
  try {
    return globalThis.localStorage?.getItem(key) || '';
  } catch {
    return '';
  }
}

function writeStorage(key, value) {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Preferences remain available for this page even when storage is blocked.
  }
}

export function normalizeLanguageChoice(value) {
  const language = String(value || '').trim().toLowerCase().replaceAll('_', '-');
  if (language === 'auto') return 'auto';
  if (language === 'zh-cht' || language.startsWith('zh-tw') || language.startsWith('zh-hk') || language.startsWith('zh-mo') || language.includes('hant')) return 'zh-tw';
  if (language === 'zh-chs' || language.startsWith('zh-my') || language === 'zh' || language.startsWith('zh-cn') || language.startsWith('zh-sg') || language.includes('hans')) return 'zh-cn';
  if (language === 'en' || language.startsWith('en-')) return 'en';
  if (language === 'fr' || language.startsWith('fr-')) return 'fr';
  if (language === 'ja' || language.startsWith('ja-')) return 'ja';
  return '';
}

export function resolveLanguageChoice(choice, browserLanguages = []) {
  const normalized = normalizeLanguageChoice(choice);
  if (normalized && normalized !== 'auto') return normalized;
  for (const language of browserLanguages) {
    const match = normalizeLanguageChoice(language);
    if (match && match !== 'auto') return match;
  }
  return 'en';
}

export function getLanguageChoice() {
  const storedChoice = normalizeLanguageChoice(readStorage(LANGUAGE_STORAGE) || readStorage('edgechat.locale'));
  const choice = storedChoice || 'auto';
  writeStorage(LANGUAGE_STORAGE, choice);
  return choice;
}

export function setLanguageChoice(value) {
  const choice = normalizeLanguageChoice(value) || 'auto';
  writeStorage(LANGUAGE_STORAGE, choice);
  writeStorage('edgechat.locale', choice);
  return choice;
}

export function normalizeThemeChoice(value) {
  const theme = String(value || '').trim().toLowerCase();
  return ['auto', 'light', 'dark'].includes(theme) ? theme : '';
}

export function getThemeChoice() {
  const choice = normalizeThemeChoice(readStorage(THEME_STORAGE)) || 'auto';
  writeStorage(THEME_STORAGE, choice);
  return choice;
}

export function setThemeChoice(value) {
  const choice = normalizeThemeChoice(value) || 'auto';
  writeStorage(THEME_STORAGE, choice);
  return choice;
}
