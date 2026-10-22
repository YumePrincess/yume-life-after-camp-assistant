import { computed, readonly, ref } from 'vue';
import { getLanguageChoice, normalizeLanguageChoice, resolveLanguageChoice, setLanguageChoice } from './preferences.js';
import { formatSiteDate } from './site-timezone.js';

export const SIMPLIFIED_CHINESE_LOCALE = 'zh-CN';
export const TRADITIONAL_CHINESE_LOCALE = 'zh-TW';
export const ENGLISH_LOCALE = 'en-US';
export const FRENCH_LOCALE = 'fr-FR';
export const JAPANESE_LOCALE = 'ja-JP';
// 保留旧名称，避免现有调用方把“简体中文”误当成全部中文后产生兼容改动。
export const CHINESE_LOCALE = SIMPLIFIED_CHINESE_LOCALE;
export const LOCALE_OPTIONS = Object.freeze([
  { value: 'auto', label: 'Auto · 自动' },
  { value: SIMPLIFIED_CHINESE_LOCALE, label: '简体中文（中国大陆）' },
  { value: TRADITIONAL_CHINESE_LOCALE, label: '繁體中文（台灣）' },
  { value: ENGLISH_LOCALE, label: 'English (United States)' },
  { value: FRENCH_LOCALE, label: 'Français (France)' },
  { value: JAPANESE_LOCALE, label: '日本語（日本）' }
]);

const localeLoaders = {
  [SIMPLIFIED_CHINESE_LOCALE]: () => import('./locales/zh-CN.js'),
  [TRADITIONAL_CHINESE_LOCALE]: () => import('./locales/zh-TW.js'),
  [ENGLISH_LOCALE]: () => import('./locales/en-US.js'),
  [FRENCH_LOCALE]: () => import('./locales/fr-FR.js'),
  [JAPANESE_LOCALE]: () => import('./locales/ja-JP.js')
};

function appLocaleForChoice(choice) {
  const language = resolveLanguageChoice(choice, globalThis.navigator?.languages || [globalThis.navigator?.language]);
  return ({
    'zh-cn': SIMPLIFIED_CHINESE_LOCALE,
    'zh-tw': TRADITIONAL_CHINESE_LOCALE,
    en: ENGLISH_LOCALE,
    fr: FRENCH_LOCALE,
    ja: JAPANESE_LOCALE
  })[language] || ENGLISH_LOCALE;
}

export function detectBrowserLocale(value) {
  const language = normalizeLanguageChoice(value);
  const resolved = language || resolveLanguageChoice('auto', [value]);
  return appLocaleForChoice(resolved);
}

const localeChoice = ref(getLanguageChoice());
const locale = ref(appLocaleForChoice(localeChoice.value));
const localeLoading = ref(false);
const activeMessages = ref({});
let translateServerError = (message) => message;

function interpolate(template, params) {
  return template.replace(/\{([a-zA-Z][\w]*)\}/g, (match, key) =>
    Object.hasOwn(params, key) ? String(params[key]) : match
  );
}

function applyDocumentLocale() {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = locale.value;
  document.title = t("camp.center");
  const description = document.querySelector('meta[name="description"]');
  if (description) description.setAttribute('content', t('app.description'));
}

export function t(key, params = {}) {
  const template = activeMessages.value[key] ?? key;
  return interpolate(template, params);
}

export function localizeServerError(value) {
  const message = String(value || '');
  return message ? translateServerError(message) : message;
}

export async function setLocale(value, { persist = true } = {}) {
  const choice = normalizeLanguageChoice(value) || 'auto';
  const nextLocale = appLocaleForChoice(choice);
  localeLoading.value = true;
  try {
    const localeModule = await localeLoaders[nextLocale]();
    activeMessages.value = localeModule.default;
    translateServerError = localeModule.localizeServerError || ((message) => message);
    localeChoice.value = choice;
    locale.value = nextLocale;
    if (persist) setLanguageChoice(choice);
    applyDocumentLocale();
  } finally {
    localeLoading.value = false;
  }
}

export function initializeI18n() {
  const sync = () => { const choice = getLanguageChoice(); if (choice !== localeChoice.value) void setLocale(choice,{persist:false}); };
  globalThis.addEventListener?.('storage',(event)=>{if(event.key==='lang') sync()});
  globalThis.addEventListener?.('focus',sync);
  return setLocale(localeChoice.value, { persist: false });
}

if (typeof globalThis.addEventListener === 'function') {
  globalThis.addEventListener('languagechange', () => {
    if (localeChoice.value === 'auto') void setLocale('auto', { persist: false });
  });
}

const SQLITE_UTC_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

export function parseDateValue(value) {
  if (value instanceof Date) return value;
  // D1 timestamps without an offset represent UTC instants, not browser wall time.
  const normalizedValue =
    typeof value === 'string' && SQLITE_UTC_DATE_TIME_PATTERN.test(value)
      ? `${value.replace(' ', 'T')}Z`
      : value;
  return new Date(normalizedValue);
}

export function formatDateTime(value, options = { dateStyle: 'medium', timeStyle: 'short' }) {
  const date = parseDateValue(value);
  return Number.isNaN(date.getTime()) ? '' : formatSiteDate(date, locale.value, options);
}

export function formatDate(value, options = { dateStyle: 'medium' }) {
  const date = parseDateValue(value);
  return Number.isNaN(date.getTime()) ? '' : formatSiteDate(date, locale.value, options);
}

export function formatTime(value, options = { hour: '2-digit', minute: '2-digit' }) {
  const date = parseDateValue(value);
  return Number.isNaN(date.getTime()) ? '' : formatSiteDate(date, locale.value, options);
}

export function compareLocalized(left, right) {
  return String(left).localeCompare(String(right), locale.value);
}

export function getLocale() {
  return locale.value;
}

export function useI18n() {
  return {
    locale: readonly(locale),
    localeChoice: readonly(localeChoice),
    localeLoading: readonly(localeLoading),
    isEnglish: computed(() => locale.value === ENGLISH_LOCALE),
    t,
    setLocale,
    formatDate,
    formatDateTime,
    formatTime,
    compareLocalized
  };
}
