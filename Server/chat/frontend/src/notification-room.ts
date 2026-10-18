export type NotificationRoom = {
  id: number | string;
  kind: string;
  name?: string;
  isGeneral?: boolean;
};

export function notificationRoomName(room: NotificationRoom, translate: (key: string) => string): string {
  // Older realtime events have the reserved name but no isGeneral flag.
  const general = room.kind !== 'dm' && (room.isGeneral || room.name === 'general');
  return general ? translate('chat.generalGroup') : room.name || translate('camp.center');
}
