<script setup>
import { computed } from 'vue';
import { parseDateValue } from '../../i18n.js';
import { messageTimestampParts } from '../../site-timezone.js';
const props = defineProps({ value: { type: [String, Number, Date], required: true } });
const instant = computed(() => parseDateValue(props.value));
const parts = computed(() => messageTimestampParts(instant.value));
</script>

<template>
  <time v-if="parts.date" class="message-time" :datetime="instant.toISOString()">
    <span>{{ parts.date }}</span>
    <span>{{ parts.time }}</span>
  </time>
</template>

<style scoped>
.message-time {
  display: grid;
  justify-items: end;
  row-gap: 2px;
  margin-top: 6px;
  text-align: right;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 1.35;
  color: var(--chat-muted);
  white-space: nowrap;
  user-select: none;
}
</style>
