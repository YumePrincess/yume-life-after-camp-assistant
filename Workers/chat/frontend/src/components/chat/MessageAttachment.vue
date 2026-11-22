<script setup>
import { computed, ref, watch } from 'vue';
import { Download, File, Image as ImageIcon, Play, Video } from '@lucide/vue';
import api from '../../api.js';
import { t } from '../../i18n.js';
import { attachmentLabel, isPreviewableImageAttachment, isPreviewableVideoAttachment } from './attachment-utils.js';
import { isAudioAttachment } from '../../voice-message.js';
import VoiceMessage from './VoiceMessage.vue';
import AttachmentPreview from './AttachmentPreview.vue';

const props = defineProps({ attachment: { type: Object, required: true } });
const previewOpen = ref(false), imageFailed = ref(false);
const isImage = computed(() => isPreviewableImageAttachment(props.attachment));
const isVideo = computed(() => isPreviewableVideoAttachment(props.attachment));
const isAudio = computed(() => isAudioAttachment(props.attachment));
const label = computed(() => attachmentLabel(props.attachment, t));
const attachmentUrl = computed(() => api.getFileUrl(props.attachment?.key || props.attachment?.url));
watch(() => props.attachment?.key || props.attachment?.url, () => {
  previewOpen.value = false;
  imageFailed.value = false;
});
</script>

<template>
  <div class="message-attachment" :class="{ 'message-attachment--image': isImage || isVideo, 'message-attachment--audio': isAudio }">
    <VoiceMessage v-if="isAudio" :attachment="attachment" />
    <template v-else-if="(isImage || isVideo) && !imageFailed">
      <button type="button" class="message-attachment__image-button" :class="{ 'message-attachment__video-button': isVideo }"
        :aria-label="t('media.preview', { type: label })" @click="previewOpen = true">
        <template v-if="isVideo">
          <video class="message-attachment__video-thumb" :src="attachmentUrl" preload="metadata" muted playsinline aria-hidden="true" />
          <span class="message-attachment__play"><span><Play :size="25" fill="currentColor" aria-hidden="true" /></span></span>
        </template>
        <img v-else class="message-attachment__image" :src="attachmentUrl" :alt="label" loading="lazy" @error="imageFailed = true" />
        <span class="message-attachment__caption"><Video v-if="isVideo" :size="14" aria-hidden="true" /><ImageIcon v-else :size="14" aria-hidden="true" />{{ label }}</span>
      </button>
      <AttachmentPreview v-if="previewOpen" :src="attachmentUrl" :is-video="isVideo" :label="label" @close="previewOpen = false" />
    </template>
    <a v-else :href="attachmentUrl" target="_blank" rel="noreferrer" class="message-attachment__file">
      <span class="message-attachment__file-icon"><File :size="22" aria-hidden="true" /></span>
      <span>{{ label }}</span><Download :size="17" aria-hidden="true" />
    </a>
  </div>
</template>
