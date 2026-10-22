<script setup>
import { File, Image as ImageIcon, Mic, Video, X } from '@lucide/vue';
import { computed } from 'vue';
import api from '../../api.js';
import { attachmentLabel, isPreviewableImageAttachment, isPreviewableVideoAttachment } from './attachment-utils.js';
import { t } from '../../i18n.js';
import { formatVoiceDuration } from '../../voice-message.js';
const props = defineProps({ attachment: { type: Object, required: true } });
const emit = defineEmits(['clear']);
const isImage = computed(() => isPreviewableImageAttachment(props.attachment));
const isVideo = computed(() => isPreviewableVideoAttachment(props.attachment));
const isVoice = computed(() => props.attachment?.kind === 'voice');
const label = computed(() => attachmentLabel(props.attachment, t));
const attachmentUrl = computed(() => api.getFileUrl(props.attachment?.key || props.attachment?.url));
</script>

<template>
  <div class="pending-attachment">
    <img v-if="isImage && !isVoice" class="pending-attachment__thumb" :src="attachmentUrl" :alt="label" />
    <span v-else class="pending-attachment__icon" aria-hidden="true"><Mic v-if="isVoice" :size="21" /><Video v-else-if="isVideo" :size="21" /><ImageIcon v-else-if="isImage" :size="21" /><File v-else :size="21" /></span>
    <span class="pending-attachment__name">{{ label }}<small v-if="isVoice">{{ formatVoiceDuration(attachment.durationMs) }}</small></span>
    <button type="button" class="pending-attachment__clear" :aria-label="t('common.remove')" @click="emit('clear')"><X :size="18" aria-hidden="true" /></button>
  </div>
</template>
