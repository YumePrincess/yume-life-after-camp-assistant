import { readonly, ref } from 'vue';
import { getThemeChoice, normalizeThemeChoice, setThemeChoice as persistThemeChoice } from './preferences.js';

const themeChoice = ref('auto');
let systemThemeQuery;

export function applyTheme(choice) {
  const next = normalizeThemeChoice(choice) || 'auto';
  if (typeof document !== 'undefined') {
    if (next === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', next);
    document.documentElement.style.colorScheme = next === 'auto' ? 'light dark' : next;
  }
  return next;
}

export function initializeTheme() {
  globalThis.addEventListener?.('storage', (event) => { if (event.key === 'yume-theme') { themeChoice.value = getThemeChoice(); applyTheme(themeChoice.value); } });
  globalThis.addEventListener?.('focus', () => { themeChoice.value = getThemeChoice(); applyTheme(themeChoice.value); });
  themeChoice.value = getThemeChoice();
  applyTheme(themeChoice.value);
  if (!systemThemeQuery && typeof globalThis.matchMedia === 'function') {
    systemThemeQuery = globalThis.matchMedia('(prefers-color-scheme: dark)');
    systemThemeQuery.addEventListener?.('change', () => {
      if (themeChoice.value === 'auto') applyTheme('auto');
    });
  }
}

export function setTheme(value) {
  themeChoice.value = persistThemeChoice(value);
  applyTheme(themeChoice.value);
}

export function useTheme() {
  return { themeChoice: readonly(themeChoice), setTheme };
}
