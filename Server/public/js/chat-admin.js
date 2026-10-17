(() => {
  "use strict";
  let csrf = "",
    generation = 0,
    confirmAction = async () => false,
    totals = null;
  const byId = (id) => document.getElementById(id);
  const t = (value) => window.MrzhI18n.t(value);
  function node(tag, className, text) {
    const el = document.createElement(tag);
    el.className = className || "";
    if (text !== undefined) {
      el.textContent = t(String(text));
      if (text) el.dataset.chatI18n = String(text);
    }
    return el;
  }
  function raw(tag, className, text) {
    const el = node(tag, className);
    el.textContent = text;
    el.dataset.i18nIgnore = "";
    return el;
  }
  function button(text, run, danger = false) {
    const el = node(
      "button",
      `button ${danger ? "button-danger" : "button-quiet"}`,
      text,
    );
    el.type = "button";
    el.onclick = async () => {
      el.disabled = true;
      try {
        await run();
      } catch (error) {
        byId("chat-admin-summary").textContent = error.message;
      } finally {
        el.disabled = false;
      }
    };
    return el;
  }
  async function api(path = "", options = {}) {
    const response = await fetch(`/api/admin/chat${path}`, {
      ...options,
      headers: { "X-CSRF-Token": csrf, ...options.headers },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(t(data.error || "加载失败"));
    return data;
  }
  const roomName = (room) =>
    room.name === "general"
      ? t("全体成员群")
      : room.kind === "dm"
        ? room.members || t("私聊")
        : room.name;
  async function messages(room, before = "") {
    const revision = ++generation;
    const payload = await api(
      `/rooms/${room.id}/messages${before ? `?before=${before}` : ""}`,
    );
    if (revision !== generation) return;
    const root = byId("chat-admin-detail");
    root.replaceChildren(
      room.name === "general"
        ? node("h2", "", "全体成员群")
        : raw("h2", "", roomName(room)),
      raw("p", "muted", room.members || ""),
    );
    if (room.name !== "general" && room.kind !== "dm")
      root.append(
        button(
          "删除群组",
          async () => {
            if (await confirmAction(t("确认删除这个群组及其消息？"))) {
              await api(`/rooms/${room.id}`, { method: "DELETE" });
              await load(csrf);
            }
          },
          true,
        ),
      );
    if (!payload.messages.length)
      root.append(node("p", "empty-state", "暂无消息"));
    for (const message of payload.messages) {
      const card = node("article", "chat-admin-message");
      const header = node("header");
      header.append(
        raw("strong", "", message.sender.displayName),
        node(
          "small",
          "muted",
          window.MrzhTimezone.timestamp(
            message.createdAt,
            document.documentElement.dataset.timezone || "UTC+08:00",
          ),
        ),
      );
      card.append(header, raw("p", "", message.content));
      if (message.attachment) {
        const link = node("a", "button button-quiet", message.attachment.name);
        link.href = `/api/admin/chat/file?key=${encodeURIComponent(message.attachment.key)}`;
        link.download = message.attachment.name;
        card.append(link);
      }
      card.append(
        button(
          "删除消息",
          async () => {
            if (await confirmAction(t("确认删除这条消息？"))) {
              await api(`/rooms/${room.id}/messages/${message.id}`, {
                method: "DELETE",
              });
              await messages(room, before);
            }
          },
          true,
        ),
      );
      root.append(card);
    }
    if (payload.messages.length === 50)
      root.append(
        button("更早的消息", () => messages(room, payload.messages[0].id)),
      );
  }
  async function load(token, before = "") {
    csrf = token;
    const revision = ++generation;
    const payload = await api(before ? `?before=${before}` : "");
    if (revision !== generation) return;
    totals = payload.totals;
    renderSummary();
    byId("chat-admin-detail").replaceChildren();
    const list = byId("chat-admin-rooms");
    list.replaceChildren();
    for (const room of payload.rooms) {
      const el = button("", () => messages(room));
      el.className = "chat-admin-room";
      el.append(
        room.name === "general"
          ? node("strong", "", "全体成员群")
          : raw("strong", "", roomName(room)),
      );
      const meta = node("small", "muted");
      meta.append(
        document.createTextNode(" · "),
        node("span", "", room.kind === "dm" ? "私聊" : "群聊"),
        document.createTextNode(` · ${room.message_count}`),
      );
      el.append(meta);
      list.append(el);
    }
    if (payload.rooms.length === 100)
      list.append(
        button("更多会话", () => load(csrf, payload.rooms.at(-1).id)),
      );
  }
  async function files(before = "") {
    const revision = ++generation;
    byId("chat-admin-rooms").replaceChildren();
    const payload = await api(`/files${before ? `?before=${before}` : ""}`);
    if (revision !== generation) return;
    const root = byId("chat-admin-detail");
    root.replaceChildren(node("h2", "", "聊天文件"));
    for (const file of payload.files) {
      const row = node("div", "chat-admin-file");
      row.append(
        raw("strong", "", file.filename),
        node(
          "small",
          "muted",
          `${file.display_name || "—"} · ${Math.ceil(file.size / 1024)} KB`,
        ),
      );
      const link = node("a", "button button-quiet", "下载");
      link.href = `/api/admin/chat/file?key=${encodeURIComponent(file.object_key)}`;
      row.append(link);
      root.append(row);
    }
    if (payload.files.length === 50)
      root.append(button("更多文件", () => files(payload.files.at(-1).cursor)));
  }
  async function audit() {
    ++generation;
    byId("chat-admin-rooms").replaceChildren();
    const payload = await api("/audit");
    const root = byId("chat-admin-detail");
    root.replaceChildren(node("h2", "", "访问日志"));
    for (const event of payload.events)
      root.append(
        node(
          "p",
          "muted",
          `${event.created_at} · ${event.actor} · ${event.action}${event.channel_id ? ` #${event.channel_id}` : ""}`,
        ),
      );
  }
  async function policy() {
    const revision = ++generation;
    byId("chat-admin-rooms").replaceChildren();
    const data = await api("/policy");
    if (revision !== generation) return;
    const root = byId("chat-admin-detail");
    root.replaceChildren(node("h2", "", "聊天运行参数"));
    const form = node("form", "form-grid");
    const fields = {
      MESSAGE_RETENTION_DAYS: "消息保留天数",
      SOFT_DELETE_RETENTION_DAYS: "删除后保留天数",
      MAX_FILE_SIZE: "单文件大小上限（字节）",
      ORPHAN_UPLOAD_RETENTION_DAYS: "未发送文件保留天数",
      ALLOWED_FILE_TYPES: "允许的文件类型",
    };
    for (const [key, label] of Object.entries(fields)) {
      const field = node("label", "field");
      field.append(node("span", "", label));
      const input = node("input");
      input.name = key;
      input.type = key === "ALLOWED_FILE_TYPES" ? "text" : "number";
      input.value = data.policy[key];
      if (input.type === "number") {
        input.min = key === "MAX_FILE_SIZE" ? 1024 : 1;
        input.max =
          key === "MAX_FILE_SIZE"
            ? 26214400
            : key === "ORPHAN_UPLOAD_RETENTION_DAYS"
              ? 30
              : 3650;
        input.step = "1";
      }
      field.append(input);
      form.append(field);
    }
    form.append(
      node(
        "p",
        "muted",
        "保存后立即生效；保留天数的清理任务每10分钟执行。单文件最大支持25MB。",
      ),
    );
    const save = node("button", "button button-primary", "保存聊天参数");
    save.type = "submit";
    const reset = button("恢复默认值", () => {
      for (const input of form.elements) {
        if (input.name in data.defaults)
          input.value = data.defaults[input.name];
      }
    });
    form.append(save, reset);
    form.onsubmit = async (event) => {
      event.preventDefault();
      save.disabled = true;
      try {
        const values = Object.fromEntries(new FormData(form));
        await api("/policy", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values),
        });
        byId("chat-admin-summary").textContent = t("聊天参数已保存");
      } catch (error) {
        showError(error);
      } finally {
        save.disabled = false;
      }
    };
    root.append(form);
  }
  document.addEventListener("DOMContentLoaded", () => {
    byId("chat-admin-refresh").onclick = () => load(csrf).catch(showError);
    byId("chat-admin-rooms-tab").onclick = () => load(csrf).catch(showError);
    byId("chat-admin-files-tab").onclick = () => files().catch(showError);
    byId("chat-admin-policy-tab").onclick = () => policy().catch(showError);
    byId("chat-admin-audit-tab").onclick = () => audit().catch(showError);
  });
  function renderSummary() {
    if (totals)
      byId("chat-admin-summary").textContent = window.MrzhI18n.format(
        "会话 {rooms} · 消息 {messages} · 文件 {files}",
        totals,
      );
  }
  document.addEventListener("mrzh:languagechange", () => {
    for (const el of document.querySelectorAll("#chat-admin [data-chat-i18n]"))
      el.textContent = t(el.dataset.chatI18n);
    renderSummary();
  });
  function showError(error) {
    byId("chat-admin-summary").textContent = error.message;
  }
  window.MrzhChatAdmin = {
    load: (token, confirmation) => {
      if (confirmation) confirmAction = confirmation;
      return load(token).catch(showError);
    },
  };
})();
