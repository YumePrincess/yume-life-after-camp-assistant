import { createApp, nextTick } from 'vue';
import '../../../public/js/mobile-viewport.js';
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
import { initLiquidGlass } from './liquid-glass.js';
import { initializeI18n } from './i18n.js';
import { initializeTheme } from './theme.js';
import { installChunkLoadRecovery } from './chunk-load.ts';
installChunkLoadRecovery(window);
initializeTheme();
async function startChat() {
  try {
    await initializeI18n();
    await store.initialize();
    if (!store.session) return;
    window.MrzhLoading?.settle('identity');
    createApp(App).use(router).mount('#app');
    await router.isReady();
    await nextTick();
    initLiquidGlass();
    window.MrzhLoading?.settle('view');
  } catch (error) {
    console.error('Chat startup failed', error);
    window.MrzhLoading?.fail();
  }
}
void startChat();
