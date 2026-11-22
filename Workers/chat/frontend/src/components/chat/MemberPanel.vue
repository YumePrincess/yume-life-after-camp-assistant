<script setup>
import { X } from '@lucide/vue';
import PresenceStatus from './PresenceStatus.vue';
import UiAvatar from '../ui/Avatar.vue';
import UiBadge from '../ui/Badge.vue';
import UiButton from '../ui/Button.vue';
import UiSurface from '../ui/Surface.vue';
import { t } from '../../i18n.js';
import SenderTitleBadge from './SenderTitleBadge.vue';

defineProps({
  room: {
    type: Object,
    default: null
  },
  members: {
    type: Array,
    default: () => []
  },
  loading: {
    type: Boolean,
    default: false
  },
  canManage: {
    type: Boolean,
    default: false
  },
  inviteUserId: {
    type: String,
    default: ''
  },
  availableInviteUsers: {
    type: Array,
    default: () => []
  },
  inviteSubmitting: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits(['close', 'update:inviteUserId', 'invite', 'remove-member', 'delete-group', 'open-profile']);
</script>

<template>
  <UiSurface v-if="room && room.kind !== 'dm'" tone="soft" class="chat-member-panel">
    <div class="chat-member-panel__header">
      <div class="window-heading">
        <h2>{{ t('members.groupMembers') }}</h2>
        <p>{{ loading ? t('common.syncing') : t('chat.memberCount', { count: members.length }) }}</p>
      </div>

      <div class="chat-member-panel__actions">
        <UiBadge variant="secondary">{{ room.myRole === 'owner' ? t('members.owner') : t('members.member') }}</UiBadge>
        <UiButton v-if="canManage && !room.isGeneral" variant="destructive" size="sm" @click="emit('delete-group')">
          {{ t('group.delete') }}
        </UiButton>
        <button type="button" class="chat-member-panel__close" :aria-label="t('chat.closeMembers')" @click="emit('close')">
          <X :size="20" aria-hidden="true" />
        </button>
      </div>
    </div>

    <p v-if="loading" role="status">{{ t('common.loading') }}</p>
    <div class="member-chip-list">
      <div v-for="member in members" :key="member.id" class="member-chip">
        <button type="button" class="profile-avatar-trigger" :aria-label="t('profile.view', { name: member.displayName })" @click="emit('open-profile', member)">
          <UiAvatar :src="member.avatarUrl" :fallback="member.displayName" size="sm" />
        </button>
        <div class="member-chip__text">
          <div class="member-chip__name">
            <strong>{{ member.displayName }}</strong>
            <SenderTitleBadge :identity="member" />
          </div>
          <span>@{{ member.username }}</span>
          <PresenceStatus :user-id="member.id" />
        </div>
        <div class="member-chip__actions">
          <UiBadge :variant="member.role === 'owner' ? 'warm' : 'secondary'">
            {{ member.role === 'owner' ? t('members.owner') : t('members.member') }}
          </UiBadge>
          <UiButton
			v-if="canManage && !room.isGeneral && member.role !== 'owner'"
            variant="secondary"
            size="sm"
            @click="emit('remove-member', member)"
          >
            {{ t('common.remove') }}
          </UiButton>
        </div>
      </div>
    </div>

    <div v-if="canManage && !room.isGeneral" class="chat-member-panel__actions">
      <select
        class="ui-input"
        :aria-label="t('members.selectInvitee')"
        :value="inviteUserId"
        @change="emit('update:inviteUserId', $event.target.value)"
      >
        <option value="">{{ t('members.selectInvitee') }}</option>
        <option v-for="user in availableInviteUsers" :key="`invite-${user.id}`" :value="user.id">
          {{ user.displayName }} @{{ user.username }}
        </option>
      </select>
      <UiButton :disabled="inviteSubmitting || !inviteUserId" @click="emit('invite')">
        {{ inviteSubmitting ? t('members.inviting') : t('members.invite') }}
      </UiButton>
    </div>
  </UiSurface>
</template>

<style scoped>
.member-chip__name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.member-chip__name strong {
  min-width: 0;
  overflow-wrap: anywhere;
}

.chat-member-panel__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  margin: -8px -8px -8px 0;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--chat-muted);
  touch-action: manipulation;
}

.chat-member-panel__close:hover,
.chat-member-panel__close:active {
  background: rgba(0, 0, 0, 0.06);
}

.chat-member-panel { display: flex; flex-direction: column; gap: 16px; min-height: 0; padding: 20px; background: transparent; color: var(--chat-ink); border: 1px solid var(--chat-line); border-radius: 0; box-shadow: none; height: 100%; min-height: 0; border: 0; }
.chat-member-panel__header { align-items: flex-start; }
.window-heading h2 { margin: 0; font-size: 18px; letter-spacing: -0.02em; }
.window-heading p { margin: 6px 0 0; color: var(--chat-muted); font-size: 13px; }
.chat-member-panel__header .chat-member-panel__actions { justify-content: flex-end; }
.member-chip-list { gap: 0; overflow-y: auto; min-height: 0; max-height: none; flex: 1; align-content: start; }
.member-chip { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 12px 0; border: 0; border-bottom: 1px solid var(--chat-line); border-radius: 0; background: transparent; }
.member-chip:last-child { border-bottom: 0; }
.member-chip__text { gap: 4px; }
.member-chip__text span { color: var(--chat-muted); font-size: 12px; overflow-wrap: anywhere; }
.member-chip__name { flex-wrap: wrap; font-size: 14px; }
.member-chip__actions { width: auto; justify-content: flex-end; align-items: center; }
.chat-member-panel :deep(.ui-badge) { background: var(--chat-hover); color: var(--chat-muted); padding: 4px 8px; border: 0; border-radius: 999px; white-space: normal; text-align: center; }
.chat-member-panel :deep(.ui-button--secondary), .chat-member-panel .ui-input { background: var(--chat-paper); color: var(--chat-ink); border-color: var(--chat-line); }
.chat-member-panel__close { color: var(--chat-muted); flex-shrink: 0; }
@media (max-width: 480px) {
  .chat-member-panel { padding: 16px; }
  .chat-member-panel__header { flex-wrap: wrap; }
  .member-chip { grid-template-columns: 44px minmax(0, 1fr); }
  .member-chip__actions { grid-column: 2; justify-content: flex-start; }
}
</style>
