import { messageMarkdownToPlainText } from "./message-markdown.ts";
import { t } from "./i18n.js";

export function conversationPreview(message) {
  const content = messageMarkdownToPlainText(message?.content || "")
    .replace(/\s+/g, " ")
    .trim();
  if (content) return content;
  const attachment = message?.attachment;
  if (!attachment) return t("chat.noMessages");
  if (attachment.kind === "voice") return t("voice.fallback");
  if (attachment.type?.startsWith("image/")) return t("conversation.image");
  if (attachment.type?.startsWith("video/")) return t("conversation.video");
  if (attachment.type?.startsWith("audio/")) return t("conversation.audio");
  return attachment.name || t("conversation.file");
}
