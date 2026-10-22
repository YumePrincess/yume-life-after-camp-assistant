const keys = ['chat.generalGroup','camp.center','notifications.directMessage','notifications.groupMessage','notifications.mentionedTitle','notifications.repliedTitle','conversation.image','conversation.video','conversation.audio','conversation.file','voice.fallback'];
const labels = {
  "zh-CN": [
    "全体成员群",
    "互动中心",
    "收到一条新私信",
    "收到一条新群聊消息",
    "有人在 {room} 提及你",
    "有人在 {room} 回复你",
    "[图片]",
    "[视频]",
    "[音频]",
    "[文件]",
    "语音消息"
  ],
  "zh-TW": [
    "全體成員群",
    "互動中心",
    "收到一條新私信",
    "收到一條新群聊消息",
    "有人在 {room} 提及你",
    "有人在 {room} 回覆你",
    "[圖片]",
    "[影片]",
    "[音訊]",
    "[檔案]",
    "語音消息"
  ],
  "ja": [
    "全メンバーグループ",
    "交流センター",
    "新しい個別メッセージが届きました",
    "新しいグループメッセージが届きました",
    "{room} でメンションされました",
    "{room} で返信がありました",
    "[画像]",
    "[動画]",
    "[音声]",
    "[ファイル]",
    "音声メッセージ"
  ],
  "fr": [
    "Tous les membres",
    "Centre d’interaction",
    "Nouveau message privé",
    "Nouveau message de groupe",
    "Vous avez été mentionné dans {room}",
    "Réponse reçue dans {room}",
    "[Image]",
    "[Vidéo]",
    "[Audio]",
    "[Fichier]",
    "Message vocal"
  ],
  "en": [
    "All members",
    "Interaction Center",
    "You received a new direct message",
    "You received a new group message",
    "You were mentioned in {room}",
    "Someone replied to you in {room}",
    "[Image]",
    "[Video]",
    "[Audio]",
    "[File]",
    "Voice message"
  ]
};

export function notificationTranslator(language) {
  const value = String(language || '').toLowerCase().replaceAll('_','-');
  const locale = value.startsWith('zh') ? (/hant|tw|hk|mo/.test(value) ? 'zh-TW' : 'zh-CN') : value.split('-')[0];
  const messages = Object.fromEntries(keys.map((key,index)=>[key,(labels[locale] || labels.en)[index]]));
  return (key,params={}) => (messages[key] || key).replace(/\{(\w+)\}/g,(match,name)=>String(params[name] ?? match));
}
