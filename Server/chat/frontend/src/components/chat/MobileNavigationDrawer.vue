<script setup>
import { Bell, BellOff, ContactRound, House, MessageCircle, X } from '@lucide/vue';
import { ref, toRef } from 'vue';
import { useOverlayLifecycle } from '../../composables/useOverlayLifecycle.js';
import { t } from '../../i18n.js';
import UiAvatar from '../ui/Avatar.vue';

const props = defineProps({
  show: { type: Boolean, default: false },
  session: { type: Object, default: null },
  notificationsEnabled: { type: Boolean, default: false },
  notificationLabel: { type: String, default: '' },
  notificationDisabled: { type: Boolean, default: false },
  activeView: { type: String, default: 'chat' }
});

const emit = defineEmits(['close', 'chat', 'contacts', 'notification']);
const drawerEl = ref(null);

useOverlayLifecycle({
  open: toRef(props, 'show'),
  onClose: () => emit('close'),
  focusTarget: drawerEl
});
</script>

<template>
  <Teleport to="body">
    <Transition name="mobile-drawer">
      <div v-if="show" class="mobile-navigation-overlay" @click.self="emit('close')">
        <aside
          ref="drawerEl"
          class="mobile-navigation-drawer"
          role="dialog"
          aria-modal="true"
          :aria-label="t('mobile.navigationMenu')"
          tabindex="-1"
        >
          <header class="mobile-navigation-drawer__header">
            <UiAvatar :src="session?.avatarUrl" :fallback="session?.displayName?.[0] || 'U'" />
            <div class="mobile-navigation-drawer__identity">
              <strong>{{ session?.displayName || t('mobile.edgechatUser') }}</strong>
              <span v-if="session?.username">@{{ session.username }}</span>
            </div>
            <button type="button" class="mobile-navigation-drawer__close" :aria-label="t('mobile.closeNavigation')" @click="emit('close')">
              <X :size="22" aria-hidden="true" />
            </button>
          </header>

          <nav class="mobile-navigation-drawer__actions" :aria-label="t('mobile.appNavigation')">
            <a href="/" class="mobile-navigation-home"><House :size="21" aria-hidden="true"/><span>{{t('camp.home')}}</span></a>
            <button type="button" :aria-current="activeView === 'chat' ? 'page' : undefined" @click="emit('chat')">
              <MessageCircle :size="21" aria-hidden="true" />
              <span>{{ t('nav.chats') }}</span>
            </button>
            <button type="button" :aria-current="activeView === 'contacts' ? 'page' : undefined" @click="emit('contacts')">
              <ContactRound :size="21" aria-hidden="true" />
              <span>{{ t('contacts.title') }}</span>
            </button>
            <button
              type="button"
              :disabled="notificationDisabled"
              :aria-pressed="notificationsEnabled"
              @click="emit('notification')"
            >
              <Bell v-if="notificationsEnabled" :size="21" aria-hidden="true" />
              <BellOff v-else :size="21" aria-hidden="true" />
              <span>{{ notificationLabel }}</span>
            </button>

          </nav>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.mobile-navigation-overlay {
  position: fixed;
  inset: 0;
  z-index: 120;
  background: var(--chat-scrim);
}

.mobile-navigation-drawer {
  width: min(84vw, 320px);
  height: 100%;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: max(18px, env(safe-area-inset-top)) 12px max(18px, env(safe-area-inset-bottom));
  background: var(--chat-glass);
  box-shadow: 12px 0 32px rgba(11, 20, 26, 0.2);
  outline: none;
  touch-action: pan-y;
  border: 1px solid var(--chat-line);
  -webkit-backdrop-filter: blur(24px) saturate(1.2);
  backdrop-filter: blur(24px) saturate(1.2);
  border-radius: 0 28px 28px 0;
}

.mobile-navigation-drawer__header {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr) 44px;
  align-items: center;
  gap: 12px;
  padding: 4px 4px 18px;
  border-bottom: 1px solid var(--chat-line);
}

.mobile-navigation-drawer__identity {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.mobile-navigation-drawer__identity strong,
.mobile-navigation-drawer__identity span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mobile-navigation-drawer__identity strong {
  color: var(--chat-ink);
  font-size: 15px;
}

.mobile-navigation-drawer__identity span {
  color: var(--chat-muted);
  font-size: 13px;
}

.mobile-navigation-drawer__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  padding: 0;
  border: 1px solid var(--chat-line);
  border-radius: 50%;
  background: var(--chat-control-fill);
  color: var(--chat-muted);
}

.mobile-navigation-drawer__actions {
  display: grid;
  gap: 4px;
  padding-top: 12px;
}

.mobile-navigation-drawer__actions button,
.mobile-navigation-drawer__actions a {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  min-height: 52px;
  padding: 0 14px;
  border: 0;
  border-radius: 16px;
  background: transparent;
  color: var(--chat-ink);
  text-align: left;
  text-decoration: none;
  touch-action: manipulation;
}

.mobile-navigation-drawer__actions button:active,
.mobile-navigation-drawer__actions a:active,
.mobile-navigation-drawer__close:active {
  background: var(--chat-hover);
}

.mobile-navigation-drawer__actions button:disabled {
  color: var(--chat-muted);
  cursor: not-allowed;
  opacity: 0.72;
}

.mobile-navigation-drawer__actions button[aria-current="page"] {
  background: var(--chat-selected);
  color: var(--chat-accent);
}

.mobile-navigation-drawer__actions .mobile-navigation-drawer__danger {
  color: var(--chat-danger);
}

.mobile-drawer-enter-active,
.mobile-drawer-leave-active {
  transition: opacity 180ms ease;
}

.mobile-drawer-enter-active .mobile-navigation-drawer,
.mobile-drawer-leave-active .mobile-navigation-drawer {
  transition: transform 220ms var(--chat-ease);
}

.mobile-drawer-enter-from,
.mobile-drawer-leave-to {
  opacity: 0;
}

.mobile-drawer-enter-from .mobile-navigation-drawer,
.mobile-drawer-leave-to .mobile-navigation-drawer {
  transform: translateX(-100%);
}

@media (prefers-reduced-motion: reduce) {
  .mobile-drawer-enter-active,
  .mobile-drawer-leave-active,
  .mobile-drawer-enter-active .mobile-navigation-drawer,
  .mobile-drawer-leave-active .mobile-navigation-drawer {
    transition: none;
  }
}
</style>

<style scoped>.mobile-navigation-home{display:flex;align-items:center;gap:12px;padding:12px 16px;color:inherit;text-decoration:none}</style>
