(() => {
  "use strict";
  const t = (value) => window.MrzhI18n.t(value);
  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className || "";
    if (text) node.textContent = t(text);
    return node;
  }
  function open(onSave) {
    const dialog = element("dialog", "app-dialog identity-avatar-dialog");
    const card = element("div", "dialog-card");
    const header = element("div", "section-heading");
    const title = element("div");
    title.append(
      element("p", "eyebrow", "AVATAR"),
      element("h2", "", "上传 / 修改头像"),
    );
    const close = element("button", "button button-quiet", "关闭");
    close.type = "button";
    close.onclick = () => dialog.close();
    header.append(title, close);
    const chooser = element("input");
    chooser.type = "file";
    chooser.accept = "image/png,image/jpeg,image/webp";
    chooser.setAttribute("aria-label", t("选择头像图片"));
    const canvas = element("canvas", "identity-avatar-canvas");
    canvas.width = 512;
    canvas.height = 512;
    canvas.hidden = true;
    const zoom = element("input");
    zoom.type = "range";
    zoom.min = "1";
    zoom.max = "3";
    zoom.step = "0.01";
    zoom.value = "1";
    zoom.hidden = true;
    zoom.setAttribute("aria-label", t("缩放头像"));
    const status = element("p", "muted");
    status.setAttribute("role", "status");
    const actions = element("div", "action-row");
    const save = element("button", "button button-primary", "保存头像");
    save.type = "button";
    save.disabled = true;
    actions.append(save);
    card.append(header, chooser, canvas, zoom, status, actions);
    dialog.append(card);
    document.body.append(dialog);
    let image = null,
      url = "",
      offsetX = 0,
      offsetY = 0,
      pointer = null;
    function draw() {
      if (!image) return;
      const scale =
        Math.max(512 / image.width, 512 / image.height) * Number(zoom.value);
      const w = image.width * scale,
        h = image.height * scale;
      offsetX = Math.max(-(w - 512) / 2, Math.min((w - 512) / 2, offsetX));
      offsetY = Math.max(-(h - 512) / 2, Math.min((h - 512) / 2, offsetY));
      const context = canvas.getContext("2d");
      context.clearRect(0, 0, 512, 512);
      context.drawImage(
        image,
        (512 - w) / 2 + offsetX,
        (512 - h) / 2 + offsetY,
        w,
        h,
      );
    }
    chooser.onchange = async () => {
      const file = chooser.files?.[0];
      if (!file) return;
      if (
        file.size > 5 * 1024 * 1024 ||
        !["image/png", "image/jpeg", "image/webp"].includes(file.type)
      ) {
        status.textContent = t("请选择5MB以内的PNG、JPEG或WebP图片");
        return;
      }
      save.disabled = true;
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(file);
      const next = new Image();
      next.src = url;
      try {
        await next.decode();
        if (next.width * next.height > 40_000_000)
          throw new Error(t("图片尺寸过大"));
        image = next;
        zoom.value = "1";
        offsetX = offsetY = 0;
        canvas.hidden = zoom.hidden = false;
        draw();
        save.disabled = false;
        status.textContent = t("拖动图片调整位置，使用滑块缩放。");
      } catch (error) {
        status.textContent = error.message || t("无法读取图片");
      }
    };
    zoom.oninput = draw;
    canvas.onpointerdown = (event) => {
      pointer = { x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
    };
    canvas.onpointermove = (event) => {
      if (!pointer) return;
      const ratio = 512 / canvas.getBoundingClientRect().width;
      offsetX += (event.clientX - pointer.x) * ratio;
      offsetY += (event.clientY - pointer.y) * ratio;
      pointer = { x: event.clientX, y: event.clientY };
      draw();
    };
    canvas.onpointerup = canvas.onpointercancel = () => {
      pointer = null;
    };
    save.onclick = async () => {
      save.disabled = true;
      chooser.disabled = zoom.disabled = true;
      close.disabled = true;
      try {
        const blob = await new Promise((resolve) =>
          canvas.toBlob(resolve, "image/webp", 0.9),
        );
        if (!blob) throw new Error(t("无法读取图片"));
        await onSave(blob);
        dialog.close();
      } catch (error) {
        status.textContent = t(error.message);
        save.disabled = false;
      } finally {
        chooser.disabled = zoom.disabled = close.disabled = false;
      }
    };
    dialog.addEventListener(
      "close",
      () => {
        if (url) URL.revokeObjectURL(url);
        dialog.remove();
      },
      { once: true },
    );
    dialog.showModal();
  }
  window.MrzhAvatar = Object.freeze({ open });
})();
