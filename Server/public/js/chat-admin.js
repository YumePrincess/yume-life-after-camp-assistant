(() => {
  "use strict";
  let csrf = "",
    generation = 0,
    mode = "rooms",
    selectedRoom = null;
  let roomListBefore = "", refreshing = null;
  let confirmAction = async () => false;
  const byId = (id) => document.getElementById(id);
  const t = (value) => window.MrzhI18n.t(value);
  const modes = ["rooms", "files", "policy"];
  function node(tag, className = "", text) {
    const el = document.createElement(tag);
    el.className = className;
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
  function status(message = "", error = false) {
    if (message) void window.MrzhFeedback.notice(t(message));
  }
  const showError = (error) => status(error.message, true);
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
        showError(error);
      } finally {
        el.disabled = false;
      }
    };
    return el;
  }
  async function api(path = "", options = {}) {
    const progress = options.method && !["GET", "HEAD"].includes(options.method.toUpperCase())
      ? window.MrzhFeedback.begin() : null;
    try {
      const response = await fetch(`/api/admin/chat${path}`, {
        ...options,
        headers: { "X-CSRF-Token": csrf, ...options.headers },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(t(data.error || "加载失败"));
      return data;
    } finally {
      if (progress !== null) window.MrzhFeedback.end(progress);
    }
  }
  function timestamp(value) {
    return window.MrzhTimezone.timestamp(
      value,
      document.documentElement.dataset.timezone || "UTC+08:00",
    );
  }
  function setMode(next) {
    mode = next;
    status();
    const workspace = byId("chat-admin-workspace");
    workspace.dataset.mode = next;
    workspace.setAttribute("aria-labelledby", `chat-admin-${next}-tab`);
    byId("chat-admin-rooms").hidden = next !== "rooms";
    for (const name of modes) {
      const tab = byId(`chat-admin-${name}-tab`);
      tab.setAttribute("aria-selected", String(name === next));
      tab.tabIndex = name === next ? 0 : -1;
    }
  }
  function empty(text) {
    return node("p", "chat-admin-empty", text);
  }
  function heading(title, subtitle) {
    const head = node("div", "chat-admin-detail-heading");
    head.append(node("h2", "", title));
    if (subtitle) head.append(node("p", "muted", subtitle));
    return head;
  }
  const roomName = (room) =>
    room.name === "general"
      ? t("全体成员群")
      : room.kind === "dm"
        ? room.members || t("私聊")
        : room.name;
  function markRoom(id) {
    for (const el of byId("chat-admin-rooms").querySelectorAll(
      "[data-room-id]",
    )) {
      el.setAttribute("aria-current", String(el.dataset.roomId === String(id)));
    }
  }
  function syncMessageCounts(room, data) {
    const count = Number(data.messageCount);
    if (Number.isSafeInteger(count) && count >= 0) {
      room.message_count = count;
      for (const el of byId("chat-admin-rooms").querySelectorAll(
        "[data-room-id]",
      )) {
        if (el.dataset.roomId === String(room.id))
          el.querySelector(".chat-admin-room-count").textContent =
            String(count);
      }
    }
    const total = Number(data.totalMessageCount);
    if (Number.isSafeInteger(total) && total >= 0)
      byId("chat-admin-total-messages").textContent = String(total);
  }
  async function messages(room, before = "") {
    const revision = ++generation;
    selectedRoom = room;
    markRoom(room.id);
    const root = byId("chat-admin-detail");
    root.replaceChildren(empty("正在载入"));
    const payload = await api(
      `/rooms/${room.id}/messages${before ? `?before=${before}` : ""}`,
    );
    if (revision !== generation) return;
    Object.assign(room, payload.room);
    syncMessageCounts(room, payload.room);
    const head = node("div", "chat-admin-detail-heading");
    head.append(
      room.name === "general"
        ? node("h2", "", "全体成员群")
        : raw("h2", "", roomName(room)),
    );
    if (room.kind !== "dm") head.append(raw("p", "chat-admin-members muted", room.members || ""));
    root.replaceChildren(head);
    if (room.name !== "general" && room.kind !== "dm")
      head.append(
        button(
          "删除群组",
          async () => {
            if (await confirmAction(t("确认删除这个群组及其消息？"))) {
              await api(`/rooms/${room.id}`, { method: "DELETE" });
              selectedRoom = null;
              await rooms();
            }
          },
          true,
        ),
      );
    if (!payload.messages.length) root.append(empty("暂无消息"));
    for (const message of payload.messages) {
      const card = node("article", "chat-admin-message");
      const header = node("header");
      header.append(
        raw("strong", "", message.sender.displayName),
        raw("time", "muted", timestamp(message.createdAt)),
      );
      if (message.recalledAt) header.append(node('span','chat-admin-recalled','已撤回'));
      card.append(header, raw("p", "chat-admin-message-body", message.content));
      const actions = node("div", "chat-admin-message-actions");
      if (message.attachment) {
        const link = raw("a", "button button-quiet chat-admin-attachment", message.attachment.name);
        link.href = `/api/admin/chat/file?key=${encodeURIComponent(message.attachment.key)}`;
        link.download = message.attachment.name;
        actions.append(link);
      }
      actions.append(
        button(
          "删除消息",
          async () => {
            if (await confirmAction(t("确认删除这条消息？"))) {
              await api(`/rooms/${room.id}/messages/${message.id}`, {
                method: "DELETE",
              });
              if (mode === "rooms" && selectedRoom?.id === room.id)
                await messages(room, before);
            }
          },
          true,
        ),
      );
      card.append(actions);
      root.append(card);
    }
    if (payload.messages.length === 50)
      root.append(
        button("更早的消息", () => messages(room, payload.messages[0].id)),
      );
  }
  function renderGeneralAvatar(avatar) {
    const image = byId("chat-admin-general-avatar-image");
    const fallback = byId("chat-admin-general-avatar-fallback");
    image.hidden = !avatar?.avatarUrl;
    fallback.hidden = Boolean(avatar?.avatarUrl);
    if (avatar?.avatarUrl) image.src = avatar.avatarUrl;
    else image.removeAttribute("src");
  }
  function renderTotals(totals) {
    for (const key of ["rooms", "messages", "files"])
      byId(`chat-admin-total-${key}`).textContent = totals[key] ?? 0;
  }
  async function rooms(before = "") {
    roomListBefore = before;
    setMode("rooms");
    const revision = ++generation;
    const payload = await api(before ? `?before=${before}` : "");
    if (revision !== generation) return;
    renderTotals(payload.totals);
    renderGeneralAvatar(payload.generalAvatar);
    const list = byId("chat-admin-rooms");
    list.replaceChildren();
    byId("chat-admin-detail").replaceChildren(empty("选择会话查看消息"));
    for (const room of payload.rooms) {
      const el = button("", () => messages(room));
      el.className = "chat-admin-room";
      el.dataset.roomId = room.id;
      el.setAttribute("aria-current", "false");
      el.append(
        room.name === "general"
          ? node("strong", "chat-admin-room-title", "全体成员群")
          : raw("strong", "chat-admin-room-title", roomName(room)),
      );
      const meta = node("small", "muted");
      meta.append(
        node(
          "span",
          "chat-admin-room-kind",
          room.kind === "dm" ? "私聊" : "群聊",
        ),
        raw("span", "chat-admin-room-count", String(room.message_count)),
        node("span", "", "消息"),
      );
      el.append(meta);
      list.append(el);
    }
    if (!payload.rooms.length) list.append(empty("暂无会话"));
    if (payload.rooms.length === 100)
      list.append(button("更多会话", () => rooms(payload.rooms.at(-1).id)));
    if (
      selectedRoom &&
      payload.rooms.some((room) => room.id === selectedRoom.id)
    )
      await messages(payload.rooms.find((room) => room.id === selectedRoom.id));
  }
  function refreshBackground() {
    if (mode !== 'rooms' || document.hidden || byId('chat-admin')?.hidden) return Promise.resolve();
    if (refreshing) return refreshing;
    const revision = generation, before = roomListBefore;
    const task = (async()=>{
      const payload = await api(before ? `?before=${before}` : '');
      if (revision !== generation || mode !== 'rooms') return;
      renderTotals(payload.totals);
      const updated = new Map(payload.rooms.map(room=>[String(room.id),room]));
      for (const el of byId('chat-admin-rooms').querySelectorAll('[data-room-id]')) {
        const room = updated.get(el.dataset.roomId);
        if (!room) continue;
        const title=el.querySelector('.chat-admin-room-title');
        if (title) title.textContent=roomName(room);
        el.querySelector('.chat-admin-room-count').textContent=String(room.message_count);
      }
      if (selectedRoom) {
        const room=updated.get(String(selectedRoom.id));
        if (room) {
          Object.assign(selectedRoom,room);
          const members=byId('chat-admin-detail').querySelector('.chat-admin-members');
          if (members) members.textContent=room.members || '';
        }
      }
    })().catch(error=>console.warn('Admin chat background refresh failed',error)).finally(()=>{if(refreshing===task) refreshing=null;});
    refreshing=task; return task;
  }
  async function files(before = "") {
    setMode("files");
    const revision = ++generation;
    const root = byId("chat-admin-detail");
    root.replaceChildren(empty("正在载入"));
    const payload = await api(`/files${before ? `?before=${before}` : ""}`);
    if (revision !== generation) return;
    root.replaceChildren(heading("聊天文件"));
    if (!payload.files.length) root.append(empty("暂无文件"));
    for (const file of payload.files) {
      const row = node("article", "chat-admin-file");
      const info = node("div", "chat-admin-file-info");
      info.append(
        raw("strong", "", file.filename),
        raw(
          "small",
          "muted",
          `${file.display_name || "—"} · ${Math.ceil(file.size / 1024)} KB · ${timestamp(file.created_at)}`,
        ),
      );
      const link = node("a", "button button-quiet", "下载");
      link.href = `/api/admin/chat/file?key=${encodeURIComponent(file.object_key)}`;
      link.download = file.filename;
      row.append(info, link);
      root.append(row);
    }
    if (payload.files.length === 50)
      root.append(button("更多文件", () => files(payload.files.at(-1).cursor)));
  }
  async function policy() {
    setMode("policy");
    const revision = ++generation;
    const root = byId("chat-admin-detail");
    root.replaceChildren(empty("正在载入"));
    const data = await api("/policy");
    if (revision !== generation) return;
    root.replaceChildren(heading("聊天运行参数"));
    const form = node("form", "chat-admin-policy");
    const fields = {
      MESSAGE_RETENTION_DAYS: "消息保留天数",
      SOFT_DELETE_RETENTION_DAYS: "删除后保留天数",
      ORPHAN_UPLOAD_RETENTION_DAYS: "未发送文件保留天数",
      MAX_FILE_SIZE: "单文件大小上限（MB）",
      ALLOWED_FILE_TYPES: "允许的文件类型",
    };
    for (const [key, label] of Object.entries(fields)) {
      const field = node(
        "label",
        `field${key === "ALLOWED_FILE_TYPES" ? " chat-admin-field-wide" : ""}`,
      );
      const title = node("span");
      title.append(node("span", "", label));
      if (key === "MAX_FILE_SIZE") title.append(window.MrzhEditingHelp.createButton("chatUpload"));
      field.append(title);
      const input = node(key === "ALLOWED_FILE_TYPES" ? "textarea" : "input");
      input.name = key;
      input.value = key === "MAX_FILE_SIZE" ? data.policy[key] / 1048576 : data.policy[key];
      if (key === "ALLOWED_FILE_TYPES") {
        input.rows = 2;
        input.spellcheck = false;
      } else {
        input.type = "number";
        input.min = key === "MAX_FILE_SIZE" ? 1 / 1024 : 1;
        input.max =
          key === "MAX_FILE_SIZE"
            ? 51200
            : key === "ORPHAN_UPLOAD_RETENTION_DAYS"
              ? 30
              : 3650;
        input.step = key === "MAX_FILE_SIZE" ? "any" : "1";
        input.required = true;
      }
      field.append(input);
      form.append(field);
    }
    const actions = node("div", "chat-admin-policy-actions");
    const save = node("button", "button button-primary", "保存聊天参数");
    save.type = "submit";
    const reset = button("恢复默认值", () => {
      for (const input of form.elements)
        if (input.name in data.defaults)
          input.value = input.name === "MAX_FILE_SIZE" ? data.defaults[input.name] / 1048576 : data.defaults[input.name];
      status();
    });
    actions.append(save, reset);
    form.append(actions);
    form.onsubmit = async (event) => {
      event.preventDefault();
      save.disabled = true;
      reset.disabled = true;
      try {
        const payload = Object.fromEntries(new FormData(form));
        payload.MAX_FILE_SIZE = Math.round(Number(payload.MAX_FILE_SIZE) * 1048576);
        await api("/policy", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        status("聊天参数已保存");
      } catch (error) {
        showError(error);
      } finally {
        save.disabled = false;
        reset.disabled = false;
      }
    };
    root.append(form);
  }
  const refresh = () => ({ rooms, files, policy })[mode]();
  document.addEventListener("DOMContentLoaded", () => {
    window.setInterval?.(refreshBackground, 15000);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden) void refreshBackground();});
    byId("chat-admin-general-avatar-edit").onclick = () => window.MrzhAvatar.open(async file => {
      const form = new FormData();
      form.append("file", file, "general-avatar.webp");
      renderGeneralAvatar(await api("/general/avatar", { method: "POST", body: form }));
    });
    byId("chat-admin-refresh").onclick = async () => {
      const button = byId("chat-admin-refresh");
      button.disabled = true;
      try {
        await refresh();
      } catch (error) {
        showError(error);
      } finally {
        button.disabled = false;
      }
    };
    for (const name of modes) {
      const tab = byId(`chat-admin-${name}-tab`);
      tab.onclick = () => ({ rooms, files, policy })[name]().catch(showError);
      tab.onkeydown = (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        const i =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? 2
              : (modes.indexOf(name) + (event.key === "ArrowRight" ? 1 : 2)) %
                3;
        const next = byId(`chat-admin-${modes[i]}-tab`);
        next.focus();
        next.click();
      };
    }
  });
  document.addEventListener("mrzh:languagechange", () => {
    for (const el of document.querySelectorAll("#chat-admin [data-chat-i18n]"))
      el.textContent = t(el.dataset.chatI18n);
  });
  window.MrzhChatAdmin = {
    refreshBackground,
    load: (token, confirmation) => {
      csrf = token;
      if (confirmation) confirmAction = confirmation;
      return rooms().catch(showError);
    },
  };
})();
