import { dispatchAuthInvalid, getStoredToken } from './auth-storage.js';
import { getEdgeChatServerOrigin, resolveServerUrl } from './capacitor-platform.ts';
import { t } from './i18n.js';
import { localizedError, localizeErrorMessage } from './localized-error.js';
import { getRuntimeFileUrl, isDemoMode, requestRuntime } from './runtime.js';
import { apiPrefix, isGatewayMode } from './gateway.ts';

function buildHeaders(extra = {}) {
  const headers = { ...extra };
  const token = getStoredToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function request(path, options = {}) {
  if (isDemoMode) {
    try {
      return await requestRuntime(path, options);
    } catch (error) {
      throw localizedError(error);
    }
  }

  const response = await fetch(resolveServerUrl(`${apiPrefix}${path}`), {
    ...options,
    headers: buildHeaders(options.headers),
    body:
      options.body instanceof FormData || typeof options.body === 'string'
        ? options.body
        : options.body
          ? JSON.stringify(options.body)
          : undefined
  });

  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const rawMessage = payload?.error?.message || payload?.error || payload || t('common.requestFailed');
    const error = new Error(localizeErrorMessage(rawMessage));
    error.status = response.status;
    error.payload = payload;
    error.rawMessage = rawMessage;

    if ((response.status === 401 || (isGatewayMode && response.status === 404
      && !contentType.includes('application/json'))) && typeof window !== 'undefined') {
      dispatchAuthInvalid(error.message);
    }

    throw error;
  }

  return payload;
}

export default {
  pushKey() { return request('/push/key'); },
  savePushSubscription(body) { return request('/push/subscription', {method:'PUT',headers:{'Content-Type':'application/json'},body}); },
  removePushSubscription(deviceId) { return request('/push/subscription', {method:'DELETE',headers:{'Content-Type':'application/json'},body:{deviceId}}); },
  session() {
    return request('/auth/session');
  },
  getSite() {
    return request('/site');
  },
  getUsers() {
    return request('/users');
  },
  getContacts(options = {}) {
    return request('/contacts', options);
  },
  getUserProfile(userId, options = {}) {
    return request(`/users/${encodeURIComponent(userId)}/profile`, options);
  },
  bootstrap() {
    return request('/bootstrap');
  },
  getChannels() {
    return request('/channels');
  },
  createGroup(payload) {
    return request('/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    });
  },
  joinChannel(channelId) {
    return request(`/channels/${channelId}/join`, { method: 'POST' });
  },
  getChannelMembers(channelId) {
    return request(`/channels/${channelId}/members`);
  },
  inviteChannelMembers(channelId, userIds) {
    return request(`/channels/${channelId}/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { userIds }
    });
  },
  removeChannelMember(channelId, userId) {
    return request(`/channels/${channelId}/members/${userId}`, {
      method: 'DELETE'
    });
  },
  deleteOwnedChannel(channelId) {
    return request(`/channels/${channelId}`, {
      method: 'DELETE'
    });
  },
  updateChannel(channelId, payload) {
    return request(`/channels/${channelId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    });
  },
  getMessages(kind, roomId, before) {
    const query = new URLSearchParams({ kind, roomId: String(roomId) });
    if (before) {
      query.set('before', String(before));
    }
    return request(`/messages?${query.toString()}`);
  },
  getRecentMessages(kind, roomId, limit = 30) {
    const query = new URLSearchParams({ limit: String(limit) });
    return request(
      `/v1/rooms/${encodeURIComponent(kind)}/${Number(roomId)}/messages?${query.toString()}`
    );
  },
  sendRoomMessage(kind, roomId, payload) {
    return request(`/v1/rooms/${encodeURIComponent(kind)}/${Number(roomId)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    });
  },
  markRoomRead(kind, roomId, messageId) {
    return request('/messages/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        kind,
        roomId,
        ...(messageId ? { messageId } : {})
      }
    });
  },
  openDm(userId) {
    return request('/dm/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { userId }
    });
  },
  listDms() {
    return request('/dm');
  },
  blockUser(userId) {
    return request(`/users/${Number(userId)}/block`, { method: 'PUT' });
  },
  unblockUser(userId) {
    return request(`/users/${Number(userId)}/block`, { method: 'DELETE' });
  },
  uploadFile(file) {
    const form = new FormData();
    form.append('file', file);
    return request('/upload', {
      method: 'POST',
      body: form
    });
  },
  getRoomWebSocketUrl(kind, roomId) {
    const token = getStoredToken();
    const url = new URL(`${apiPrefix}/ws/${kind}/${roomId}`, getEdgeChatServerOrigin());
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  },
  getDirectoryWebSocketUrl() {
    const url = new URL(`${apiPrefix}/directory/ws`, getEdgeChatServerOrigin());
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  },
  getInboxWebSocketUrl() {
    const token = getStoredToken();
    const url = new URL(`${apiPrefix}/inbox/ws`, getEdgeChatServerOrigin());
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  },
  getFileUrl(keyOrUrl) {
    const raw = String(keyOrUrl || '');
    if (!raw) {
      return '';
    }
    if (isDemoMode) {
      return getRuntimeFileUrl(raw);
    }

    const url = raw.startsWith('/chat/files/') || raw.startsWith('/api/public/identity-avatar/')
      ? new URL(resolveServerUrl(raw), getEdgeChatServerOrigin())
      : new URL(resolveServerUrl(`/chat/files/${encodeURIComponent(raw)}`), getEdgeChatServerOrigin());
    const token = getStoredToken();
    if (token) {
      url.searchParams.set('token', token);
    }
    return resolveServerUrl(url.pathname + url.search);
  }
};
