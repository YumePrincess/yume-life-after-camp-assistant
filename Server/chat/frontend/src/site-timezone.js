import { ref } from 'vue';
import { normalizeUtcTimezone, utcOffsetMinutes, formatUtcTimezoneLabel } from '../../../src/time.ts';

export const siteTimezone = ref('UTC+08:00');
export function setSiteTimezone(value) {
  if (!value) return;
  try { siteTimezone.value = normalizeUtcTimezone(String(value)); }
  catch { /* Keep the last valid server setting while an old response is being replaced. */ }
}
export function initializeSiteTimezone(browserWindow = globalThis.window) {
  if (!browserWindow?.document) return () => {};
  let root = browserWindow.document.documentElement;
  try { root = browserWindow.parent?.document?.documentElement || root; } catch { /* Standalone client. */ }
  const sync = () => setSiteTimezone(root.dataset.timezone);
  sync();
  const Observer = browserWindow.MutationObserver;
  const observer = Observer ? new Observer(sync) : null;
  observer?.observe(root, { attributes: true, attributeFilter: ['data-timezone'] });
  return () => observer?.disconnect();
}
export function siteLocalDate(date) {
  return new Date(date.getTime() + utcOffsetMinutes(siteTimezone.value, date) * 60000);
}
export function formatSiteDate(date, locale, options) {
  const shifted = siteLocalDate(date);
  const formatter = new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' });
  if (!options?.timeZoneName) return formatter.format(shifted);
  return formatter.formatToParts(shifted).map(part => part.type === 'timeZoneName'
    ? formatUtcTimezoneLabel(siteTimezone.value, date) : part.value).join('');
}
export function messageTimestampParts(date) {
  if (!Number.isFinite(date.getTime())) return { date: '', time: '' };
  const local = siteLocalDate(date), pad = value => String(value).padStart(2, '0');
  return {
    date: `${local.getUTCFullYear()}/${pad(local.getUTCMonth() + 1)}/${pad(local.getUTCDate())}`,
    time: `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())} (${formatUtcTimezoneLabel(siteTimezone.value, date)})`
  };
}
