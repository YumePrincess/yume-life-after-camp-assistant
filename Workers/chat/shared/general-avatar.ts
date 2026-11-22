export const GENERAL_AVATAR_SETTING = 'chat_general_avatar';
export function generalAvatarUrl(key: string | null | undefined): string {
  return key ? `/api/public/chat-general-avatar?v=${encodeURIComponent(key)}` : '';
}
