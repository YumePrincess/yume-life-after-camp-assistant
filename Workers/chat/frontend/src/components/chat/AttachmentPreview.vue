<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { ExternalLink, Image as ImageIcon, Maximize, Pause, Play, Video, Volume2, VolumeX, X } from '@lucide/vue';
import { t } from '../../i18n.js';
import { useOverlayLifecycle } from '../../composables/useOverlayLifecycle.js';
import { formatMediaTime, mediaSeekTime } from '../../media-playback.js';

const props = defineProps({
  src: { type: String, required: true },
  isVideo: { type: Boolean, default: false },
  label: { type: String, required: true }
});
const emit = defineEmits(['close']);
const open = ref(true), overlay = ref(null), surface = ref(null), video = ref(null);
const playing = ref(false), muted = ref(false), current = ref(0), duration = ref(0);
const failed = ref(false), nativeFullscreen = ref(false);
const progress = computed(() => duration.value > 0 ? Math.min(1000, current.value / duration.value * 1000) : 0);
const time = computed(() => `${formatMediaTime(current.value)} / ${formatMediaTime(duration.value)}`);
const canFullscreen = computed(() => Boolean(surface.value?.requestFullscreen || video.value?.webkitEnterFullscreen));
useOverlayLifecycle({ open, onClose: () => emit('close'), focusTarget: overlay });

function updateTime() {
  current.value = Number.isFinite(video.value?.currentTime) ? video.value.currentTime : 0;
  duration.value = Number.isFinite(video.value?.duration) ? video.value.duration : 0;
}
async function togglePlayback() {
  if (!video.value || failed.value) return;
  if (video.value.paused) {
    try { await video.value.play(); }
    catch { playing.value = false; } // Autoplay may be blocked; the play button remains available.
  } else video.value.pause();
}
function seek(event) {
  if (!video.value || !duration.value) return;
  video.value.currentTime = mediaSeekTime(event.target.value, duration.value);
  updateTime();
}
function toggleMute() {
  if (!video.value) return;
  video.value.muted = !video.value.muted;
  muted.value = video.value.muted;
}
async function fullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (surface.value?.requestFullscreen) await surface.value.requestFullscreen();
    else video.value?.webkitEnterFullscreen?.();
  } catch { /* The external viewer remains available when fullscreen is restricted. */ }
}
function mediaError() {
  failed.value = true;
  playing.value = false;
  void window.MrzhFeedback?.notice(t('media.unavailable'));
}
onMounted(async () => {
  await nextTick();
  if (props.isVideo) await togglePlayback();
});
onBeforeUnmount(() => {
  video.value?.pause();
  if (document.fullscreenElement === surface.value) void document.exitFullscreen()?.catch(() => {});
});
</script>

<template>
  <Teleport to="body">
    <div ref="overlay" class="attachment-preview" role="dialog" aria-modal="true"
      :aria-label="t('media.preview', { type: label })" tabindex="-1" @click.self="emit('close')">
      <section ref="surface" class="attachment-preview__surface" :class="{ 'attachment-preview__surface--video': isVideo }">
        <header class="attachment-preview__header">
          <span class="attachment-preview__type-icon" aria-hidden="true"><Video v-if="isVideo" :size="21" /><ImageIcon v-else :size="21" /></span>
          <div class="attachment-preview__heading"><span class="attachment-preview__eyebrow">MEDIA</span><h2>{{ label }}</h2></div>
          <a class="attachment-preview__icon-button" :href="src" target="_blank" rel="noreferrer"
            :aria-label="t(isVideo ? 'attachments.openVideo' : 'attachments.openOriginal')" :title="t(isVideo ? 'attachments.openVideo' : 'attachments.openOriginal')">
            <ExternalLink :size="19" aria-hidden="true" />
          </a>
          <button class="attachment-preview__icon-button attachment-preview__close" type="button" :aria-label="t('common.close')" @click="emit('close')"><X :size="20" aria-hidden="true" /></button>
        </header>
        <div class="attachment-preview__stage">
          <video v-if="isVideo" ref="video" class="attachment-preview__media" :src="src" :controls="nativeFullscreen" playsinline preload="metadata" :aria-label="label"
            @loadedmetadata="updateTime" @durationchange="updateTime" @timeupdate="updateTime"
            @play="playing = true" @pause="playing = false" @ended="playing = false; updateTime()"
            @volumechange="muted = video?.muted || video?.volume === 0" @click="togglePlayback" @error="mediaError"
            @webkitbeginfullscreen="nativeFullscreen = true" @webkitendfullscreen="nativeFullscreen = false" />
          <img v-else class="attachment-preview__media" :src="src" :alt="label" />
          <button v-if="isVideo && !playing && !failed" class="attachment-preview__center-play" type="button" :aria-label="t('media.play')" @click="togglePlayback"><Play :size="30" fill="currentColor" aria-hidden="true" /></button>
        </div>
        <footer v-if="isVideo" class="attachment-preview__controls">
          <input class="attachment-preview__seek" type="range" min="0" max="1000" step="1" :value="progress" :disabled="!duration || failed"
            :aria-label="t('media.seek')" :aria-valuetext="time" :style="{ '--media-progress': `${progress / 10}%` }" @input="seek" />
          <div class="attachment-preview__playback">
            <button class="attachment-preview__icon-button attachment-preview__toggle" type="button" :disabled="failed" :aria-label="t(playing ? 'media.pause' : 'media.play')" @click="togglePlayback"><Pause v-if="playing" :size="19" fill="currentColor" aria-hidden="true" /><Play v-else :size="19" fill="currentColor" aria-hidden="true" /></button>
            <span class="attachment-preview__time">{{ time }}</span>
            <button class="attachment-preview__icon-button" type="button" :aria-label="t(muted ? 'media.unmute' : 'media.mute')" @click="toggleMute"><VolumeX v-if="muted" :size="20" aria-hidden="true" /><Volume2 v-else :size="20" aria-hidden="true" /></button>
            <button v-if="canFullscreen" class="attachment-preview__icon-button" type="button" :aria-label="t('media.fullscreen')" @click="fullscreen"><Maximize :size="19" aria-hidden="true" /></button>
          </div>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style src="../../styles/attachment-preview.css"></style>
