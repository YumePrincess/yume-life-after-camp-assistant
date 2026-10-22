import { notificationRoomTitle } from '../../shared/notification-content.js';
export type NotificationRoom = {
  id: number | string;
  kind: string;
  name?: string;
  isGeneral?: boolean;
};

export function notificationRoomName(room: NotificationRoom, translate: (key: string) => string): string {
  return notificationRoomTitle(room, translate);
}
