<script setup lang="ts">
import { watch } from 'vue';
import { chunkLoadFailed } from '../chunk-load.ts';
import { useI18n } from '../i18n.js';

const { t } = useI18n();
watch(chunkLoadFailed, async failed => {
  if (!failed) return;
  await window.MrzhFeedback.notice(t('common.chunkLoadFailed'), {
    actions: [{ label: t('common.reload'), run: () => window.location.reload() }]
  });
  chunkLoadFailed.value = false;
});
</script>

<template></template>
