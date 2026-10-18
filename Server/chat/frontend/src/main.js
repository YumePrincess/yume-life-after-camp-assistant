import { createApp, nextTick } from 'vue';
import '../../../public/js/mobile-viewport.js';
import '../../../public/js/operation-feedback.js';
import '../../../public/operation-feedback.css';
import App from './App.vue';
import router from './router.js';
import store from './store.js';
import './styles/base.css';
import './styles/theme.css';
import './styles.css';
import './styles-liquid.css';
import './styles/tokens.css';
import './styles/layout.css';
import './styles/ui.css';
import '../../../public/camp-theme.css';
import { initLiquidGlass } from './liquid-glass.js';
import { initializeI18n, setLocale } from './i18n.js';
import { initializeTheme, applyTheme } from './theme.js';
import { getLanguageChoice, getThemeChoice } from './preferences.js';
import { initializeHostNavigation } from './host-navigation.js';
import { installChunkLoadRecovery } from './chunk-load.ts';
installChunkLoadRecovery(window);
initializeTheme();
async function startChat() {
  try {
    await initializeI18n();
    await store.initialize();
    if (!store.session) return;
    window.MrzhLoading?.settle('identity');
    await router.replace('/');
    createApp(App).use(router).mount('#app');
    await router.isReady();
    await nextTick();
    initLiquidGlass();
    initializeHostNavigation({
      async activate() {
        applyTheme(getThemeChoice());
        await setLocale(getLanguageChoice(), { persist: false });
        await store.initialize();
        window.dispatchEvent(new Event('resize'));
      },
      deactivate() { document.activeElement?.blur?.(); }
    });
    window.MrzhLoading?.settle('view');
  } catch (error) {
    console.error('Chat startup failed', error);
    window.MrzhLoading?.fail();
  }
}
void startChat();
