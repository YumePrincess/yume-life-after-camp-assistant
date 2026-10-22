<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { Play } from '@lucide/vue';
import api from '../../api.js';
import { useOverlayLifecycle } from '../../composables/useOverlayLifecycle.js';
import { t } from '../../i18n.js';
import { isPreviewableImageAttachment, isPreviewableVideoAttachment } from './attachment-utils.js';
import { isAudioAttachment } from '../../voice-message.js';
import VoiceMessage from './VoiceMessage.vue';

const props = defineProps({
  attachment: {
    type: Object,
    required: true
  }
});

const previewOpen = ref(false);
const previewEl = ref(null);
const imageFailed = ref(false);
const isImage = computed(() => isPreviewableImageAttachment(props.attachment));
const isVideo = computed(() => isPreviewableVideoAttachment(props.attachment));
const videoEl = ref(null);
const isAudio = computed(() => isAudioAttachment(props.attachment));
const displayName = computed(() => props.attachment?.name || t('attachments.fallback'));
const openOriginalLabel = computed(() => t(isVideo.value ? 'attachments.openVideoNamed' : 'attachments.openOriginalNamed', { name: displayName.value }));
const attachmentUrl = computed(() => api.getFileUrl(props.attachment?.key || props.attachment?.url));

useOverlayLifecycle({
  open: previewOpen,
  onClose: closePreview,
  focusTarget: previewEl
});

async function openPreview() {
  if ((!isImage.value && !isVideo.value) || imageFailed.value) {
    return;
  }

  previewOpen.value = true;
  if (isVideo.value) { await nextTick(); videoEl.value?.play()?.catch(() => {}); }
}

function closePreview() {
  videoEl.value?.pause();
  previewOpen.value = false;
}

watch(
  () => props.attachment?.key || props.attachment?.url,
  () => {
    closePreview();
    imageFailed.value = false;
  }
);
</script>

<template>
	  <div class="message-attachment" :class="{ 'message-attachment--image': isImage || isVideo, 'message-attachment--audio': isAudio }">
	    <VoiceMessage v-if="isAudio" :attachment="attachment" />
	    <template v-else-if="isImage || isVideo">
      <button
        v-if="!imageFailed"
        type="button"
        class="message-attachment__image-button"
        :class="{ 'message-attachment__video-button': isVideo }"
        :aria-label="t(isVideo ? 'attachments.videoPreviewNamed' : 'attachments.previewNamed', { name: displayName })"
        @click="openPreview"
      >
        <template v-if="isVideo">
          <video class="message-attachment__video-thumb" :src="attachmentUrl" preload="metadata" muted playsinline aria-hidden="true" />
          <span class="message-attachment__play"><Play :size="28" aria-hidden="true" /></span>
          <span class="message-attachment__video-name">{{ displayName }}</span>
        </template>
        <img v-else
          class="message-attachment__image"
          :src="attachmentUrl"
          :alt="displayName"
          loading="lazy"
          @error="imageFailed = true"
        />
      </button>
      <a
        v-else
        :href="attachmentUrl"
        target="_blank"
        rel="noreferrer"
        class="chat-bubble__attachment message-attachment__file"
      >
        {{ displayName }}
      </a>

      <Teleport to="body">
        <div
          v-if="previewOpen"
          ref="previewEl"
          class="image-preview-overlay"
          role="dialog"
          aria-modal="true"
          :aria-label="t(isVideo ? 'attachments.videoPreviewNamed' : 'attachments.imagePreviewNamed', { name: displayName })"
          tabindex="-1"
          @click.self="closePreview"
        >
          <div class="image-preview-overlay__toolbar">
            <span class="image-preview-overlay__title">{{ displayName }}</span>
            <a
              class="image-preview-overlay__action"
              :href="attachmentUrl"
              target="_blank"
              rel="noreferrer"
              :aria-label="openOriginalLabel"
            >
              {{ t(isVideo ? 'attachments.openVideo' : 'attachments.openOriginal') }}
            </a>
            <button type="button" class="image-preview-overlay__close" :aria-label="t(isVideo ? 'common.close' : 'attachments.closePreview')" @click="closePreview">
              {{ t('common.close') }}
            </button>
          </div>
          <video v-if="isVideo" ref="videoEl" class="image-preview-overlay__video" :src="attachmentUrl" controls playsinline preload="metadata" :aria-label="displayName" />
          <img v-else class="image-preview-overlay__image" :src="attachmentUrl" :alt="displayName" />
        </div>
      </Teleport>
    </template>

    <a
      v-else
      :href="attachmentUrl"
      target="_blank"
      rel="noreferrer"
      class="chat-bubble__attachment message-attachment__file"
    >
      {{ displayName }}
    </a>
  </div>
</template>
