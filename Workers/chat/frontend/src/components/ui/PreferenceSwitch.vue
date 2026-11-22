<script setup>
import { Check, Languages, Monitor, Moon, Sun } from '@lucide/vue';
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { LOCALE_OPTIONS, useI18n } from '../../i18n.js';
import { useTheme } from '../../theme.js';

const { locale, localeChoice, localeLoading, setLocale, t } = useI18n();
const { themeChoice, setTheme } = useTheme();
const root = ref(null);
const menuOpen = ref(false);
const themeOptions = [
  { value: 'auto', label: 'theme.auto', icon: Monitor },
  { value: 'light', label: 'theme.light', icon: Sun },
  { value: 'dark', label: 'theme.dark', icon: Moon }
];

function isLocaleSelected(value) {
  return localeChoice.value === 'auto' ? value === 'auto' : locale.value === value;
}

function closeMenu() {
  menuOpen.value = false;
}

async function toggleMenu() {
  menuOpen.value = !menuOpen.value;
  if (!menuOpen.value) return;
  await nextTick();
  root.value?.querySelector('[aria-pressed="true"]')?.focus();
}

async function selectLocale(value) {
  if (!isLocaleSelected(value)) await setLocale(value);
  closeMenu();
}

function selectTheme(value) {
  setTheme(value);
  closeMenu();
}

function handleOutsidePointer(event) {
  if (!root.value?.contains(event.target)) closeMenu();
}

onMounted(() => document.addEventListener('pointerdown', handleOutsidePointer));
onBeforeUnmount(() => document.removeEventListener('pointerdown', handleOutsidePointer));
</script>

<template>
  <div ref="root" class="preference-switch" @keydown.esc="closeMenu">
    <button
      type="button"
      class="preference-switch__trigger"
      :title="t('preferences.select')"
      :aria-label="t('preferences.select')"
      :aria-expanded="menuOpen"
      aria-haspopup="dialog"
      @click="toggleMenu"
    >
      <Languages :size="21" aria-hidden="true" />
    </button>

    <div v-if="menuOpen" class="preference-switch__menu" role="dialog" :aria-label="t('preferences.select')">
      <section class="preference-switch__section" :aria-label="t('language.select')">
        <h2>{{ t('language.select') }}</h2>
        <div class="preference-switch__options" role="group" :aria-label="t('language.select')">
          <button
            v-for="option in LOCALE_OPTIONS"
            :key="option.value"
            type="button"
            class="preference-switch__option"
            :aria-pressed="isLocaleSelected(option.value)"
            :disabled="localeLoading"
            @click="selectLocale(option.value)"
          >
            <span :lang="option.value === 'auto' ? undefined : option.value">{{ option.value === 'auto' ? t('language.auto') : option.label }}</span>
            <Check v-if="isLocaleSelected(option.value)" :size="16" aria-hidden="true" />
          </button>
        </div>
      </section>

      <section class="preference-switch__section" :aria-label="t('theme.select')">
        <h2>{{ t('theme.select') }}</h2>
        <div class="preference-switch__options" role="group" :aria-label="t('theme.select')">
          <button
            v-for="option in themeOptions"
            :key="option.value"
            type="button"
            class="preference-switch__option preference-switch__option--theme"
            :aria-pressed="themeChoice === option.value"
            @click="selectTheme(option.value)"
          >
            <component :is="option.icon" :size="16" aria-hidden="true" />
            <span>{{ t(option.label) }}</span>
            <Check v-if="themeChoice === option.value" :size="16" aria-hidden="true" />
          </button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.preference-switch { position: relative; display: inline-flex; }
.preference-switch__trigger {
  width: 44px;
  min-width: 44px;
  height: 44px;
  display: inline-grid;
  place-items: center;
  padding: 0;
  border: 1px solid rgba(88, 107, 124, .22);
  border-radius: 8px;
  background: var(--preference-control-bg, rgba(255,255,255,.72));
  color: currentColor;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.72);
  cursor: pointer;
  touch-action: manipulation;
  transition: background 180ms ease, border-color 180ms ease, transform 180ms ease;
}
.preference-switch__trigger:hover { border-color: rgba(45,156,151,.42); background: var(--preference-control-hover, rgba(255,255,255,.94)); }
.preference-switch__trigger:active { transform: scale(.96); }
.preference-switch__trigger:focus-visible { outline: 2px solid rgba(45,156,151,.62); outline-offset: 2px; }
.preference-switch__menu {
  position: absolute;
  z-index: 120;
  top: calc(100% + 8px);
  right: 0;
  width: min(280px, calc(100vw - 24px));
  max-height: min(70vh, 520px);
  overflow-y: auto;
  padding: 8px;
  border: 1px solid rgba(88,107,124,.2);
  border-radius: 8px;
  background: var(--preference-menu-bg, rgba(255,255,255,.98));
  color: var(--preference-menu-text, #1f292e);
  box-shadow: 0 12px 32px rgba(27,44,56,.16);
}
.preference-switch__section + .preference-switch__section { margin-top: 7px; padding-top: 8px; border-top: 1px solid var(--line, rgba(88,107,124,.16)); }
.preference-switch__section h2 { margin: 0 0 4px; padding: 0 10px; color: var(--muted, #65747e); font-size: 11px; font-weight: 650; letter-spacing: .04em; }
.preference-switch__options { display: grid; }
.preference-switch__option {
  width: 100%;
  min-height: 38px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 16px;
  align-items: center;
  gap: 10px;
  padding: 0 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.preference-switch__option--theme { grid-template-columns: 18px minmax(0, 1fr) 16px; }
.preference-switch__option:hover:not(:disabled), .preference-switch__option:focus-visible { outline: none; background: rgba(45,156,151,.1); }
.preference-switch__option[aria-pressed='true'] { color: #08766a; font-weight: 650; }
.preference-switch__option:disabled { opacity: .55; cursor: wait; }
html[data-theme='dark'] .preference-switch__option[aria-pressed='true'] { color: #78d1c4; }
@media (prefers-color-scheme: dark) {
  html:not([data-theme='light']) .preference-switch__option[aria-pressed='true'] { color: #78d1c4; }
}
@media (prefers-reduced-motion: reduce) { .preference-switch__trigger { transition: none; } }
</style>
