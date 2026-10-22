import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({ html: false, breaks: true });
export function messagePreviewText(content) {
  const parts = [];
  for (const token of markdown.parse(String(content || ''), {})) {
    if (token.type === 'fence' || token.type === 'code_block') parts.push(token.content);
    for (const child of token.children || []) {
      if (['text', 'code_inline', 'image'].includes(child.type)) parts.push(child.content);
      else if (['softbreak', 'hardbreak'].includes(child.type)) parts.push(' ');
    }
    if (token.type === 'inline') parts.push(' ');
  }
  return parts.join('').replace(/\s+/gu, ' ').trim();
}
function shorten(value, maximum) {
  const characters = Array.from(String(value || '').replace(/\s+/gu, ' ').trim());
  return characters.length > maximum ? characters.slice(0, maximum - 1).join('') + '…' : characters.join('');
}
export function notificationRoomTitle(room, translate) {
  return room.kind !== 'dm' && (room.isGeneral || room.name === 'general')
    ? translate('chat.generalGroup') : room.name || translate('camp.center');
}
export function notificationContent(event, translate) {
  const room = event.room || event;
  const senderName = shorten(event.sender?.displayName || event.sender?.username || room.name || translate('camp.center'), 80);
  const roomName = shorten(room.kind === 'dm' && !room.name ? senderName : notificationRoomTitle(room, translate), 100);
  const attachment = event.attachment;
  let preview = messagePreviewText(event.contentPreview || '');
  if (!preview && attachment) {
    preview = attachment.kind === 'voice' ? translate('voice.fallback')
      : attachment.type?.startsWith('image/') ? translate('conversation.image')
      : attachment.type?.startsWith('video/') ? translate('conversation.video')
      : attachment.type?.startsWith('audio/') ? translate('conversation.audio')
      : translate('conversation.file');
  }
  preview = shorten(preview || translate(room.kind === 'dm' ? 'notifications.directMessage' : 'notifications.groupMessage'), 160);
  const title = event.replyToMe ? translate('notifications.repliedTitle', {room:roomName})
    : event.mentionsMe ? translate('notifications.mentionedTitle', {room:roomName}) : roomName;
  const body = room.kind !== 'dm' && senderName !== roomName ? `${senderName}: ${preview}` : preview;
  return {title, body, roomName, senderName, preview};
}
