<script setup>
import { computed } from 'vue';
import { onlineUserIds, presenceReady } from '../../directory.js';
import { t } from '../../i18n.js';
const props = defineProps({userId:{type:[Number,String],required:true}});
const online = computed(()=>presenceReady.value && onlineUserIds.value.has(Number(props.userId)));
</script>
<template>
  <span class="presence-status" :class="{'is-online':online}" role="status">
    <span class="presence-status__dot" aria-hidden="true"></span>
    {{ !presenceReady ? t('presence.syncing') : online ? t('presence.online') : t('presence.offline') }}
  </span>
</template>
<style scoped>
.presence-status { display:inline-flex; align-items:center; gap:5px; flex-shrink:0; color:var(--chat-muted); font-size:12px; line-height:1.5; white-space:nowrap; }
.presence-status__dot { width:7px; height:7px; border-radius:50%; background:currentColor; opacity:.6; }
.presence-status.is-online { color:var(--chat-online); }
.presence-status.is-online .presence-status__dot { opacity:1; }
</style>
