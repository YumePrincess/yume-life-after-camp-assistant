(() => {
  "use strict";
  const t = value => window.MrzhI18n.t(value);
  let dialog, player, error, title, close;
  function safeUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
    } catch { return ""; }
  }
  function node(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    if (text) element.textContent = text;
    return element;
  }
  function syncPlayerAspectRatio() {
    if (!dialog.open || !(player.videoWidth > 0) || !(player.videoHeight > 0)) return;
    const ratio = player.videoWidth / player.videoHeight;
    if (Number.isFinite(ratio)) dialog.style.setProperty("--media-aspect-ratio", String(ratio));
  }
  function initialize() {
    if (dialog) return;
    dialog = node("dialog", "video-preview-dialog");
    dialog.id = "video-preview-dialog";
    dialog.setAttribute("aria-labelledby", "video-preview-title");
    const header = node("div", "section-heading");
    title = node("h2", "", t("视频预览")); title.id = "video-preview-title";
    close = node("button", "feature-detail-close video-preview-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", t("关闭"));
    close.autofocus = true;
    close.addEventListener("click", () => dialog.close());
    header.append(title, close);
    const surface = node("div", "video-preview-surface");
    player = node("video", "video-preview-player");
    player.controls = true;
    player.playsInline = true;
    player.preload = "metadata";
    player.addEventListener("loadedmetadata", syncPlayerAspectRatio);
    player.addEventListener("resize", syncPlayerAspectRatio);
    error = node("p", "video-preview-error", t("视频无法播放，请检查链接或视频格式。"));
    error.setAttribute("role", "status");
    error.hidden = true;
    player.addEventListener("error", () => { if (dialog.open) error.hidden = false; });
    surface.append(player, error);
    dialog.append(header, surface);
    dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener("close", () => {
      player.pause();
      player.removeAttribute("src");
      player.load();
      dialog.style.removeProperty("--media-aspect-ratio");
      error.hidden = true;
    });
    document.body.append(dialog);
    window.addEventListener("pagehide", () => { if (dialog.open) dialog.close(); });
  }
  function open(block) {
    const url = safeUrl(block.url);
    if (!url) return;
    initialize();
    player.pause();
    dialog.style.removeProperty("--media-aspect-ratio");
    close.setAttribute("aria-label", t("关闭"));
    error.hidden = true;
    error.textContent = t("视频无法播放，请检查链接或视频格式。");
    title.textContent = block.alt || t("视频预览");
    player.setAttribute("aria-label", title.textContent);
    player.src = url;
    player.load();
    if (!dialog.open) dialog.showModal();
    // A denied autoplay request leaves the native play/pause/seek controls usable.
    player.play().catch(() => {});
  }
  function card(block) {
    const url = safeUrl(block.url);
    if (!url) return null;
    const button = node("button", "rich-video-card");
    button.type = "button";
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-label", block.alt || t("播放视频"));
    const preview = node("video", "rich-video-thumbnail");
    preview.src = url;
    preview.muted = true;
    preview.playsInline = true;
    preview.preload = "metadata";
    preview.tabIndex = -1;
    preview.setAttribute("aria-hidden", "true");
    const play = node("span", "rich-video-play", "▶");
    play.setAttribute("aria-hidden", "true");
    const caption = node("span", "rich-video-caption", block.alt || t("播放视频"));
    button.append(preview, play, caption);
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      open(block);
    });
    button.addEventListener("keydown", event => event.stopPropagation());
    return button;
  }
  window.MrzhContentMedia = Object.freeze({ card, open });
})();
