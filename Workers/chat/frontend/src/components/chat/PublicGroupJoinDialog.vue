<script setup>
import { Globe2, UserPlus, X } from '@lucide/vue';
import { ref, toRef } from 'vue';
import { useOverlayLifecycle } from '../../composables/useOverlayLifecycle.js';
import { t } from '../../i18n.js';
import UiAvatar from '../ui/Avatar.vue';

const props = defineProps({
  show: { type: Boolean, default: false },
  channel: { type: Object, default: null },
  joining: { type: Boolean, default: false }
});

const emit = defineEmits(['close', 'join']);
const joinButtonEl = ref(null);

useOverlayLifecycle({
  open: toRef(props, 'show'),
  onClose: () => {
    if (!props.joining) emit('close');
  },
  focusTarget: joinButtonEl
});
</script>

<template>
  <Teleport to="body">
  <Transition name="public-group-fade">
    <div v-if="show && channel" class="public-group-overlay" @click.self="!joining && emit('close')">
      <section class="public-group-dialog" role="dialog" aria-modal="true" aria-labelledby="public-group-title">
        <button
          type="button"
          class="public-group-dialog__close"
          :aria-label="t('common.close')"
          :disabled="joining"
          @click="emit('close')"
        >
          <X :size="20" aria-hidden="true" />
        </button>

        <UiAvatar :src="channel.avatarUrl" :fallback="channel.name?.[0] || t('publicGroups.fallback')" size="lg" />
        <div class="public-group-dialog__identity">
          <span class="public-group-dialog__kind"><Globe2 :size="15" aria-hidden="true" />{{ t('chat.publicGroup') }}</span>
          <h2 id="public-group-title">{{ channel.name }}</h2>
          <p v-if="channel.description">{{ channel.description }}</p>
        </div>

        <dl class="public-group-dialog__facts">
          <div>
            <dt>{{ t('chat.members') }}</dt>
            <dd>{{ t('publicGroups.peopleCount', { count: Number(channel.memberCount || 0) }) }}</dd>
          </div>
          <div>
            <dt>{{ t('publicGroups.owner') }}</dt>
            <dd>{{ channel.ownerDisplayName || t('common.unknown') }}</dd>
          </div>
        </dl>

        <div class="public-group-dialog__actions">
          <button type="button" class="public-group-dialog__secondary" :disabled="joining" @click="emit('close')">
            {{ t('common.cancel') }}
          </button>
          <button
            ref="joinButtonEl"
            type="button"
            class="public-group-dialog__primary"
            :disabled="joining"
            @click="emit('join')"
          >
            <UserPlus :size="18" aria-hidden="true" />
            {{ joining ? t('publicGroups.joining') : t('publicGroups.join') }}
          </button>
        </div>
      </section>
    </div>
  </Transition>
  </Teleport>
</template>

<style scoped>
section { color: var(--chat-ink); font-family: var(--chat-font); overflow-wrap: anywhere; }
button, input { font: inherit; }
button:active:not(:disabled) { filter: brightness(0.94); }
button:focus-visible, input:focus-visible { outline: 2px solid var(--chat-accent); outline-offset: 3px; }
.room-dialog__input { color: var(--chat-ink); }
.room-dialog__secondary { color: var(--chat-ink); }
.room-dialog__primary { background: var(--chat-primary-fill); color: var(--chat-primary-ink); }

.public-group-overlay {
  position: fixed;
  inset: 0;
  z-index: 115;
  display: flex;
  align-items: center;
  justify-content: center;
  padding:
    max(16px, env(safe-area-inset-top))
    max(16px, env(safe-area-inset-right))
    max(16px, env(safe-area-inset-bottom))
    max(16px, env(safe-area-inset-left));
  background: var(--chat-scrim);
}

.public-group-dialog {
  position: relative;
  display: grid;
  justify-items: center;
  width: min(400px, 100%);
  max-height: calc(100dvh - 32px);
  overflow-y: auto;
  padding: 32px 28px 24px;
  border-radius: var(--chat-radius-dialog);
  background: var(--chat-glass);
  border: 1px solid var(--chat-line);
  -webkit-backdrop-filter: blur(24px) saturate(1.2);
  backdrop-filter: blur(24px) saturate(1.2);
  box-shadow: 0 20px 60px rgba(11, 20, 26, 0.18);
  text-align: center;
}

.public-group-dialog__close {
  position: absolute;
  top: 12px;
  right: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  padding: 0;
  border: 1px solid var(--chat-line);
  border-radius: 50%;
  background: var(--chat-control-fill);
  color: var(--chat-muted);
  cursor: pointer;
}

.public-group-dialog__close:hover {
  background: var(--chat-hover);
  color: var(--chat-ink);
}

.public-group-dialog__identity {
  display: grid;
  justify-items: center;
  gap: 6px;
  margin-top: 16px;
}

.public-group-dialog__kind {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--chat-accent);
  font-size: 12px;
  font-weight: 600;
}

.public-group-dialog h2 {
  max-width: 100%;
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--chat-ink);
  font-size: 20px;
}

.public-group-dialog__identity p {
  margin: 0;
  color: var(--chat-muted);
  font-size: 13px;
  line-height: 1.55;
}

.public-group-dialog__facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  width: 100%;
  margin: 24px 0 0;
  padding: 16px 0;
  border-top: 1px solid var(--chat-line);
  border-bottom: 1px solid var(--chat-line);
}

.public-group-dialog__facts div {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.public-group-dialog__facts div + div {
  border-left: 1px solid var(--chat-line);
}

.public-group-dialog__facts dt {
  color: var(--chat-subtle);
  font-size: 12px;
}

.public-group-dialog__facts dd {
  margin: 0;
  overflow: hidden;
  color: var(--chat-ink);
  font-size: 14px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.public-group-dialog__actions {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
  width: 100%;
  margin-top: 24px;
}

.public-group-dialog__secondary,
.public-group-dialog__primary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 44px;
  padding: 10px 16px;
  border-radius: var(--chat-radius-control);
  cursor: pointer;
}

.public-group-dialog__secondary {
  border: 1px solid var(--chat-line);
  background: var(--chat-paper);
  color: var(--chat-ink);
}

.public-group-dialog__primary {
  border: 1px solid var(--chat-accent);
  background: var(--chat-primary-fill);
  color: var(--chat-primary-ink);
}

.public-group-dialog button:disabled {
  cursor: wait;
  opacity: 0.58;
}

.public-group-dialog button:focus-visible {
  outline: 3px solid var(--chat-accent);
  outline-offset: 2px;
}

.public-group-fade-enter-active {
  transition: opacity 200ms ease-out;
}

.public-group-fade-leave-active {
  transition: opacity 150ms ease-in;
}

.public-group-fade-enter-from,
.public-group-fade-leave-to {
  opacity: 0;
}

@media (max-width: 480px) {
  .public-group-overlay {
    align-items: flex-end;
    padding: 0;
  }

  .public-group-dialog {
    width: 100%;
    max-height: calc(100dvh - env(safe-area-inset-top));
    padding: 28px 20px max(20px, env(safe-area-inset-bottom));
    border-radius: var(--chat-radius-dialog) var(--chat-radius-dialog) 0 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .public-group-fade-enter-active,
  .public-group-fade-leave-active {
    transition: none;
  }
}
</style>
