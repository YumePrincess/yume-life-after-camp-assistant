const LANGUAGE_COOKIE = 'yume-preference-language';
const THEME_COOKIE = 'yume-preference-theme';
const LANGUAGE_STORAGE = 'lang';
const THEME_STORAGE = 'yume-theme';

function readCookie(name) {
  const prefix = `${name}=`;
  for (const part of (globalThis.document?.cookie || '').split(';')) {
    const value = part.trim();
    if (!value.startsWith(prefix)) continue;
    try {
      return decodeURIComponent(value.slice(prefix.length));
    } catch {
      return value.slice(prefix.length);
    }
  }
  return '';
}

function writeCookie(name, value) {
  if (!globalThis.document || !globalThis.location) return;
  const hostname = globalThis.location.hostname.toLowerCase().replace(/\.$/, '');
  const attributes = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'Max-Age=31536000', 'SameSite=Lax'];
  if (hostname === 'yume.zone' || hostname.endsWith('.yume.zone')) attributes.push('Domain=yume.zone');
  if (globalThis.location.protocol === 'https:') attributes.push('Secure');
  globalThis.document.cookie = attributes.join('; ');
}

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
    // The yume.zone cookie remains the shared preference source when storage is unavailable.
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
  const cookieChoice = normalizeLanguageChoice(readCookie(LANGUAGE_COOKIE));
  if (cookieChoice) {
    writeStorage(LANGUAGE_STORAGE, cookieChoice);
    return cookieChoice;
  }

  // Migrate the earlier app-only preference once into the shared Yume preference cookie.
  const storedChoice = normalizeLanguageChoice(readStorage(LANGUAGE_STORAGE) || readStorage('edgechat.locale'));
  const choice = storedChoice || 'auto';
  writeCookie(LANGUAGE_COOKIE, choice);
  writeStorage(LANGUAGE_STORAGE, choice);
  return choice;
}

export function setLanguageChoice(value) {
  const choice = normalizeLanguageChoice(value) || 'auto';
  writeCookie(LANGUAGE_COOKIE, choice);
  writeStorage(LANGUAGE_STORAGE, choice);
  writeStorage('edgechat.locale', choice);
  return choice;
}

export function normalizeThemeChoice(value) {
  const theme = String(value || '').trim().toLowerCase();
  return ['auto', 'light', 'dark'].includes(theme) ? theme : '';
}

export function getThemeChoice() {
  const cookieChoice = normalizeThemeChoice(readCookie(THEME_COOKIE));
  if (cookieChoice) {
    writeStorage(THEME_STORAGE, cookieChoice);
    return cookieChoice;
  }
  const choice = normalizeThemeChoice(readStorage(THEME_STORAGE)) || 'auto';
  writeCookie(THEME_COOKIE, choice);
  writeStorage(THEME_STORAGE, choice);
  return choice;
}

export function setThemeChoice(value) {
  const choice = normalizeThemeChoice(value) || 'auto';
  writeCookie(THEME_COOKIE, choice);
  writeStorage(THEME_STORAGE, choice);
  return choice;
}
