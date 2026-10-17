<script setup>
import { Globe2, LockKeyhole } from '@lucide/vue';
import { computed, ref, toRef, watch } from 'vue';
import { useOverlayLifecycle } from '../../composables/useOverlayLifecycle.js';
import { t } from '../../i18n.js';
import UiAvatar from '../ui/Avatar.vue';

const props = defineProps({
  show: { type: Boolean, default: false },
  users: { type: Array, default: () => [] },
  form: { type: Object, required: true },
  submitting: { type: Boolean, default: false },
  error: { type: String, default: '' }
});

const emit = defineEmits(['close', 'toggle-member', 'submit']);
const nameInputEl = ref(null);
const memberQuery = ref('');
const filteredUsers = computed(() => {
  const query = memberQuery.value.trim().toLocaleLowerCase();
  return props.users.filter(user => `${user.displayName} ${user.username}`.toLocaleLowerCase().includes(query));
});
watch(() => props.show, () => { memberQuery.value = ''; });

useOverlayLifecycle({
  open: toRef(props, 'show'),
  onClose: () => emit('close'),
  focusTarget: nameInputEl
});
</script>

<template>
  <Teleport to="body">
  <Transition name="modal-fade">
    <div v-if="show" class="room-dialog-overlay" @click.self="emit('close')">
      <section class="room-dialog" role="dialog" aria-modal="true" aria-labelledby="create-group-title">
        <h2 id="create-group-title">{{ t('group.create') }}</h2>
        <label class="room-dialog__field">
          <span>{{ t('group.name') }}</span>
          <input ref="nameInputEl" v-model="form.name" type="text" class="room-dialog__input" autocomplete="off" />
        </label>

		<div class="room-dialog__type-field">
			  <span>{{ t('group.type') }}</span>
			  <div class="room-dialog__type-switch" role="radiogroup" :aria-label="t('group.type')">
			<label
			  :class="{ 'room-dialog__type-option--active': form.kind === 'public' }"
			  class="room-dialog__type-option"
			>
			  <input v-model="form.kind" type="radio" name="group-kind" value="public" />
			  <Globe2 :size="17" aria-hidden="true" />
				  <span>{{ t('chat.publicGroup') }}</span>
			</label>
			<label
			  :class="{ 'room-dialog__type-option--active': form.kind === 'private' }"
			  class="room-dialog__type-option"
			>
			  <input v-model="form.kind" type="radio" name="group-kind" value="private" />
			  <LockKeyhole :size="17" aria-hidden="true" />
				  <span>{{ t('chat.privateGroup') }}</span>
			</label>
		  </div>
		</div>

        <div class="room-dialog__members">
			  <label>{{ form.kind === 'public' ? t('group.inviteOptional') : t('group.selectMembers') }}</label>
          <input v-model="memberQuery" type="search" class="room-dialog__input" :placeholder="t('contacts.search')" :aria-label="t('contacts.search')" />
          <p class="room-dialog__selection-count" aria-live="polite">{{ t('group.selectedCount', { count: form.memberUserIds.length }) }}</p>
          <p v-if="!filteredUsers.length" class="room-dialog__selection-count">{{ t('contacts.noResults') }}</p>
          <div class="room-dialog__member-list">
            <button
              v-for="user in filteredUsers"
              :key="user.id"
              type="button"
              class="room-dialog__member"
              :class="{ 'room-dialog__member--selected': form.memberUserIds.includes(user.id) }"
              :aria-pressed="form.memberUserIds.includes(user.id)"
              @click="emit('toggle-member', user.id)"
            >
              <UiAvatar :src="user.avatarUrl" :fallback="user.displayName?.[0] || '?'" size="sm" />
              <span class="room-dialog__member-identity"><strong>{{ user.displayName }}</strong><small>@{{ user.username }}</small></span>
              <span class="room-dialog__check" aria-hidden="true">{{ form.memberUserIds.includes(user.id) ? '✓' : '' }}</span>
            </button>
          </div>
        </div>

        <p v-if="error" class="room-dialog__error" role="alert">{{ error }}</p>

        <div class="room-dialog__actions">
          <button type="button" class="room-dialog__secondary" @click="emit('close')">{{ t('common.cancel') }}</button>
          <button
            type="button"
            class="room-dialog__primary"
            :disabled="!form.name.trim() || submitting"
            @click="emit('submit')"
          >
            {{ submitting ? t('common.creating') : t('common.create') }}
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
.room-dialog__primary { background: var(--chat-accent); color: var(--chat-paper); }

.room-dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 1200;
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

.room-dialog {
  width: min(420px, 100%);
  max-height: calc(100dvh - 32px);
  overflow-y: auto;
  padding: 24px;
  border-radius: var(--chat-radius-dialog);
  background: var(--chat-paper);
  box-shadow: var(--chat-glass-shadow);
  border: 1px solid var(--chat-glass-rim);
  background: var(--chat-glass);
  backdrop-filter: blur(20px) saturate(1.1);
  -webkit-backdrop-filter: blur(20px) saturate(1.1);
}

.room-dialog h2 { margin: 0 0 20px; font-size: 18px; color: var(--chat-ink); }
.room-dialog__field { display: grid; gap: 8px; color: var(--chat-muted); font-size: 13px; }
.room-dialog__input { width: 100%; min-height: 44px; padding: 10px 14px; border: 1px solid var(--chat-line); border-radius: var(--chat-radius-control); background: var(--chat-canvas); font-size: 16px; }
.room-dialog__type-field { display: grid; gap: 8px; margin-top: 20px; color: var(--chat-muted); font-size: 13px; }
.room-dialog__type-switch { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px; padding: 4px; border: 1px solid var(--chat-line); border-radius: var(--chat-radius-control); background: var(--chat-canvas); }
.room-dialog__type-option { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-width: 0; min-height: 40px; padding: 8px 10px; border: 0; border-radius: 6px; background: transparent; color: var(--chat-muted); font-size: 13px; cursor: pointer; }
.room-dialog__type-option input { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
.room-dialog__type-option:focus-within { outline: 3px solid rgba(0, 128, 105, 0.24); outline-offset: 2px; }
.room-dialog__type-option--active { background: var(--chat-paper); color: var(--chat-accent); box-shadow: 0 1px 3px rgba(11, 20, 26, 0.12); }
.room-dialog__members { margin-top: 20px; }
.room-dialog__members > label { display: block; margin-bottom: 8px; font-size: 13px; color: var(--chat-muted); }
.room-dialog__member-list { display: flex; flex-wrap: wrap; gap: 8px; max-height: 180px; overflow-y: auto; }
.room-dialog__member { display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 8px 12px; border: 1px solid var(--chat-line); border-radius: var(--chat-radius-dialog); background: var(--chat-paper); cursor: pointer; touch-action: manipulation; }
.room-dialog__member--selected { border-color: var(--chat-accent); background: var(--chat-selected); }
.room-dialog__actions { display: flex; justify-content: flex-end; gap: 12px; margin-top: 24px; }
.room-dialog__error { margin: 16px 0 0; color: #b42318; font-size: 13px; overflow-wrap: anywhere; }
.room-dialog__secondary, .room-dialog__primary { min-height: 44px; padding: 10px 20px; border-radius: var(--chat-radius-control); cursor: pointer; touch-action: manipulation; }
.room-dialog__secondary { border: 1px solid var(--chat-line); background: var(--chat-paper); }
.room-dialog__primary { border: 0; background: var(--chat-accent); color: var(--chat-paper); }
.room-dialog__primary:disabled { cursor: not-allowed; opacity: 0.55; }
.room-dialog button:focus-visible { outline: 3px solid rgba(0, 128, 105, 0.24); outline-offset: 2px; }
.modal-fade-enter-active { transition: opacity 200ms; }
.modal-fade-leave-active { transition: opacity 150ms; }
.modal-fade-enter-from, .modal-fade-leave-to { opacity: 0; }

@media (max-width: 480px) {
  .room-dialog-overlay {
    align-items: flex-end;
    padding: env(safe-area-inset-top) 0 0;
  }

  .room-dialog {
    width: 100%;
    max-height: calc(100dvh - env(safe-area-inset-top));
    padding: 20px 16px max(16px, env(safe-area-inset-bottom));
    border-radius: var(--chat-radius-dialog) var(--chat-radius-dialog) 0 0;
  }

  .room-dialog__actions {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
}

.room-dialog__member-list { display: grid; gap: 0; max-height: 240px; border: 1px solid var(--chat-line); border-radius: 14px; }
.room-dialog__member { width: 100%; border: 0; border-bottom: 1px solid var(--chat-line); border-radius: 0; padding: 10px 12px; text-align: start; color: var(--chat-ink); }
.room-dialog__member:last-child { border-bottom: 0; }
.room-dialog__member:hover { background: var(--chat-hover); }
.room-dialog__member--selected { background: var(--chat-selected); }
.room-dialog__member-identity { display: grid; gap: 3px; flex: 1; min-width: 0; overflow-wrap: anywhere; }
.room-dialog__member-identity small, .room-dialog__selection-count { color: var(--chat-muted); font-size: 12px; }
.room-dialog__check { display: grid; place-items: center; flex: 0 0 22px; height: 22px; border: 1px solid var(--chat-line); border-radius: 50%; color: var(--chat-accent); }
.room-dialog__member--selected .room-dialog__check { background: var(--chat-accent); color: var(--chat-paper); }
</style>
