(() => {
  "use strict";

  const FALLBACK_TASKS = [
    ["tech_switch", "更新科技", "按固定科技与投票结果开启次日科技"],
    ["contribution_sync", "更新贡献", "仅从市政厅沙盘更新三项贡献数据"],
    ["inactivity_sync", "更新斩杀预警", "仅从市政厅沙盘活跃页更新离线时间"],
    [
      "member_profile_sync",
      "更新成员资料",
      "更新职业、庄园、同居与公职，并以完整成员页刷新当前名单"
    ],
    ["weekly_activity_sync", "更新周活跃点", "读取营地周计划中的活跃排行并更新成员周活跃点"],
    ["patrol", "营地巡逻", "组队、困难路线与定时古籍分享"]
  ];
  const TECHNOLOGY_ROW_SLOT_COUNT = 6;
  const CONFIG_SECTIONS = ["general", "tasks", "agent", "technology"];
  const VIEW_PERMISSIONS = {
    overview: "admin:overview",
    general: "admin:general",
    tasks: "admin:tasks",
    agent: "admin:agent",
    plugins: "admin:plugins",
    technology: "admin:technology",
    "technology-history": "admin:technology-history",
    "daily-vote": "admin:daily-vote",
    "identity-applications": "admin:identity-review",
    "identity-codes": "admin:identity-codes",
    smtp: "admin:smtp",
    access: "admin:access",
    members: "admin:members",
    history: "admin:history"
  };
  const TASK_NAMES = {
    ...Object.fromEntries(FALLBACK_TASKS.map(([key, name]) => [key, name])),
    member_sync: "成员同步",
    automation_routine: "任务例程"
  };
  const ACTIVE_STATES = new Set(["queued", "claimed", "running", "cancelling"]);
  const state = {
    bootstrap: null,
    csrfToken: "",
    dirtySections: new Set(),
    refreshing: false,
    saving: false,
    memberEditSaving: false,
    liveSocket: null,
    liveReconnectTimer: null,
    liveReconnectAttempt: 0,
    liveDirty: false,
    memberQuery: "",
    selectedMember: null,
    technologyDate: "",
    technologyDraft: null,
    technologyPresetId: "",
    technologyQuery: "",
    technologyCategory: "all",
    technologyHistory: { dates: [], history: null },
    technologyHistoryLoading: false,
    technologyHistoryLoaded: false,
    technologyHistoryReloadQueued: false,
    technologyHistoryReloadDate: "",
    activeVoteDetail: null,
    dailyVoteItems: [],
    dailyVoteItemsByMode: { active: [], history: [] },
    activeDailyVoteDetail: null,
    dailyVoteConfig: {
      drawMaxWins28Days: 4,
      voteEligibilityEnabled: true,
      voteEligibility: {
        weeklyContribution: 1500,
        technologyPoints: 0,
        materialContribution: 50000,
        weeklyActivityPoints: 25
      }
    },
    dailyVotePage: 1,
    dailyVoteTotal: 0,
    dailyVoteHistoryPage: 1,
    dailyVoteHistoryTotal: 0,
    dailyVoteLoading: false,
    dailyVoteReloadRequest: null,
    dailyVoteEditorItem: null,
    activeView: "overview",
    accessAllowed: false,
    activeEventRunId: null,
    eventRefreshInFlight: false,
    eventSignature: "",
    eventEntries: [],
    eventLastId: null,
    eventLoaded: false,
    eventLocaleRevision: 0,
    runActionMenu: null,
    identityApplications: { page: 1, total: 0, items: [] },
    identityCodes: { page: 1, total: 0, items: [] },
    identityListRefreshQueued: false,
    temporaryKeys: { page: 1, total: 0, items: [] },
    identityApplicationSearch: "",
    identityApplicationStatus: "",
    identityCodeSearch: "",
    identityCodeStatus: "",
    temporaryKeySearch: "",
    temporaryKeyStatus: "",
    editingTemporaryKeyId: null,
    selectedIdentityApplication: null,
    selectedIdentityCode: null,
    selectedIdentityPasswordResetCode: null,
    publicContentLocale: "zh-cn",
    publicContentDraft: null,
    smtpConfigLoaded: false,
    smtpConfigLoading: false,
    smtpDraftRevision: 0,
    smtpDirty: false,
    scheduleDrafts: {},
    scheduleWeekdayDrafts: {},
    scheduleReplacements: {},
    scheduleDialogTaskKey: null,
    maintenanceAction: null,
    loadedPluginClientModules: new Set()
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function translateUi(value) {
    return typeof value === "string" && window.MrzhI18n?.t
      ? window.MrzhI18n.t(value)
      : value;
  }

  function formatUi(source, values = {}) {
    return window.MrzhI18n?.format
      ? window.MrzhI18n.format(source, values)
      : source;
  }

  function create(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text instanceof Node) {
      element.append(text);
    } else if (text !== undefined) {
      element.textContent = translateUi(text);
    }
    return element;
  }

  const appModalState = {
    resolve: null,
    mode: "confirm",
    restoreFocus: null
  };

  function closeAppModal(value) {
    const root = byId("app-modal");
    const resolve = appModalState.resolve;
    const restoreFocus = appModalState.restoreFocus;
    appModalState.resolve = null;
    appModalState.restoreFocus = null;
    if (root) {
      root.classList.remove("is-open");
      root.setAttribute("aria-hidden", "true");
      window.setTimeout(() => {
        if (!appModalState.resolve) {
          if (root.open) root.close();
          root.hidden = true;
        }
      }, 180);
    }
    if (resolve) resolve(value);
    if (restoreFocus && typeof restoreFocus.focus === "function") {
      window.setTimeout(() => restoreFocus.focus(), 180);
    }
  }

  function openAppModal(options = {}) {
    const root = byId("app-modal");
    if (!root) return Promise.resolve(options.mode === "prompt" ? null : false);
    if (appModalState.resolve) {
      closeAppModal(options.mode === "prompt" ? null : false);
    }
    const mode = options.mode || "confirm";
    const inputField = byId("app-modal-input-field");
    const input = byId("app-modal-input");
    const textarea = byId("app-modal-textarea");
    const confirm = byId("app-modal-confirm");
    const cancel = byId("app-modal-cancel");
    byId("app-modal-eyebrow").textContent = translateUi(options.eyebrow || "ACTION");
    byId("app-modal-title").textContent = translateUi(options.title || "确认操作");
    byId("app-modal-message").textContent = options.message || "";
    inputField.hidden = mode !== "prompt";
    if (mode === "prompt") {
      byId("app-modal-input-label").textContent = translateUi(options.inputLabel || "有效期");
      const control = options.multiline && textarea ? textarea : input;
      input.hidden = control !== input;
      if (textarea) textarea.hidden = control !== textarea;
      control.value = options.inputValue || "";
      control.placeholder = options.inputPlaceholder || "";
      if (control === input) input.type = options.inputType || "text";
      if (options.maxLength) control.maxLength = options.maxLength;
    } else {
      input.value = "";
      input.placeholder = "";
      input.hidden = false;
      if (textarea) {
        textarea.value = "";
        textarea.placeholder = "";
        textarea.hidden = true;
      }
    }
    cancel.hidden = options.showCancel === false;
    confirm.textContent = translateUi(options.confirmLabel || "确认");
    cancel.textContent = translateUi(options.cancelLabel || "取消");
    confirm.classList.toggle("button-danger", options.danger === true);
    confirm.classList.toggle("button-primary", options.danger !== true);
    root.hidden = false;
    root.setAttribute("aria-hidden", "false");
    if (!root.open) root.showModal();
    appModalState.mode = mode;
    appModalState.restoreFocus = document.activeElement;
    return new Promise((resolve) => {
      appModalState.resolve = resolve;
      window.requestAnimationFrame(() => {
        root.classList.add("is-open");
        if (mode === "prompt") {
          (options.multiline && textarea ? textarea : input).focus();
        }
        else confirm.focus();
      });
    });
  }

  function showAppAlert(message, options = {}) {
    return openAppModal({
      ...options,
      mode: "alert",
      message,
      showCancel: false,
      confirmLabel: options.confirmLabel || "关闭"
    });
  }

  function showAppConfirm(message, options = {}) {
    return openAppModal({ ...options, mode: "confirm", message });
  }

  function showAppPrompt(message, options = {}) {
    return openAppModal({ ...options, mode: "prompt", message });
  }

  function appModalInputValue() {
    const textarea = byId("app-modal-textarea");
    const input = byId("app-modal-input");
    const control = textarea && !textarea.hidden ? textarea : input;
    return control ? control.value.trim() : "";
  }

  function installAppModal() {
    const root = byId("app-modal");
    if (!root) return;
    root.addEventListener("click", (event) => {
      if (event.target.closest("[data-app-modal-dismiss]")) {
        closeAppModal(appModalState.mode === "prompt" ? null : false);
      }
      if (event.target.closest("#app-modal-confirm")) {
        closeAppModal(
          appModalState.mode === "prompt"
            ? appModalInputValue()
            : true
        );
      }
    });
    root.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeAppModal(appModalState.mode === "prompt" ? null : false);
      } else if (
        event.key === "Enter" &&
        appModalState.mode === "prompt" &&
        event.target.id !== "app-modal-textarea"
      ) {
        event.preventDefault();
        closeAppModal(appModalInputValue());
      }
    });
    root.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeAppModal(appModalState.mode === "prompt" ? null : false);
    });
  }

  function createRunActionButton(label, className, icon) {
    const localizedLabel = translateUi(label);
    const button = create(
      "button",
      `button run-action-button ${className}`.trim()
    );
    button.type = "button";
    button.title = localizedLabel;
    button.setAttribute("aria-label", localizedLabel);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute(
      "d",
      icon === "stop"
        ? "M7.5 7.5h9v9h-9z M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z"
        : icon === "operation"
          ? "M7 9.5l5 5 5-5"
          : "M5 5h14v14H5z M8 9h8 M8 12h8 M8 15h5"
    );
    svg.append(path);
    button.append(svg, create("span", "run-action-label", localizedLabel));
    return button;
  }

  function input(name) {
    return document.querySelector(`[name="${name}"]`);
  }

  async function request(path, options = {}) {
    const headers = {
      "Content-Type": "application/json",
      ...(options.headers || {})
    };
    if (options.method && !["GET", "HEAD"].includes(options.method)) {
      headers["X-CSRF-Token"] = state.csrfToken;
    }
    const response = await fetch(path, { ...options, headers });
    if (response.status === 401) {
      location.href = `/login?returnTo=${encodeURIComponent("/admin")}`;
      throw new Error("登录已失效");
    }
    const payload = await response.json();
    if (!response.ok) {
      const message = payload.error || `HTTP ${response.status}`;
      throw new Error(window.MrzhI18n?.t ? window.MrzhI18n.t(message) : message);
    }
    return payload;
  }

  function taskName(value) {
    const task = (state.bootstrap?.plugins || [])
      .flatMap((plugin) => plugin.tasks || [])
      .find((item) => item.key === value);
    return translateUi(task?.name || TASK_NAMES[value] || value);
  }

  function permissionName(value) {
    return state.bootstrap?.permissionCatalog?.find((item) => item.key === value)?.label || (
      {
        "system:admin": "系统最高权限",
        "demo:preview": "Demo · 全后台只读",
        "admin:overview": "控制台",
        "admin:general": "基础设置",
        "admin:tasks": "任务计划",
        "admin:agent": "执行策略",
        "admin:plugins": "Workers 插件",
        "admin:technology": "科技管理",
        "admin:technology-history": "科技投票历史",
        "admin:daily-vote": "日常投票事项",
        "admin:identity-review": "识别码审批",
        "admin:identity-codes": "身份识别码",
        "admin:smtp": "SMTP 发信",
        "admin:access": "访问密钥",
        "admin:members": "成员管理",
        "admin:history": "运行记录",
        "config:write": "修改配置",
        "technology-history:manage": "管理科技投票历史",
        "task:run": "执行任务",
        "task:interrupt": "中断任务",
        "keys:manage": "管理 Key",
        "identity:review": "审批身份识别码",
        "identity:manage": "管理身份识别码",
        "smtp:manage": "管理 SMTP 配置"
      }[value] || value
    );
  }

  function permissionAliases(permission) {
    const catalog = state.bootstrap?.permissionCatalog || [];
    return catalog.find((item) => item.key === permission)?.aliases || [];
  }

  function hasPermission(permission) {
    const permissions = state.bootstrap?.session?.permissions || [];
    return (
      permissions.includes("*") ||
      permissions.includes("system:admin") ||
      permissions.includes(permission) ||
      permissionAliases(permission).some((alias) =>
        permissions.includes(alias)
      )
    );
  }

  function canView(view) {
    const permissions = state.bootstrap?.session?.permissions || [];
    const declaredOwner = document.querySelector(
      `[data-admin-view="${CSS.escape(view)}"][data-worker-plugin], [data-nav-target="${CSS.escape(view)}"][data-worker-plugin]`
    )?.dataset.workerPlugin;
    if (declaredOwner) {
      const declaredPlugin = (state.bootstrap?.plugins || []).find(
        (plugin) => plugin.id === declaredOwner
      );
      if (!declaredPlugin?.enabled) return false;
    }
    const owner = (state.bootstrap?.plugins || []).find((plugin) =>
      (plugin.adminModules || []).some((module) => module.view === view)
    );
    if (owner && !owner.enabled) return false;
    const pluginPermission = owner?.adminModules?.find(
      (module) => module.view === view
    )?.permission;
    return (
      permissions.includes("*") ||
      permissions.includes("demo:preview") ||
      hasPermission(pluginPermission || VIEW_PERMISSIONS[view])
    );
  }

  function stateName(value) {
    const label = {
      queued: "排队",
      claimed: "已领取",
      running: "执行中",
      cancelling: "中断中",
      interrupted: "已中断",
      succeeded: "成功",
      partially_succeeded: "部分完成",
      failed: "失败",
      timed_out: "已超时",
      skipped: "已跳过"
    }[value] || value;
    return translateUi(label);
  }

  function formatDate(value) {
    if (!value) return "—";
    const locale = {
      "zh-cn": "zh-CN",
      "zh-tw": "zh-TW",
      en: "en",
      fr: "fr",
      ja: "ja"
    }[window.MrzhI18n.language()] || "zh-CN";
    return new Intl.DateTimeFormat(locale, {
      timeZone: configuredTimezone(),
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(new Date(value));
  }

  function formatIdentityExpiry(value) {
    if (!value) return window.MrzhI18n.t("永久有效");
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    const locale = {
      "zh-cn": "zh-CN",
      "zh-tw": "zh-TW",
      en: "en",
      fr: "fr",
      ja: "ja"
    }[window.MrzhI18n.language()] || "zh-CN";
    const timezone = configuredTimezone();
    const formatted = new Intl.DateTimeFormat(locale, {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(date);
    return `${formatted} (${timezone})`;
  }

  function formatVoteDate(value) {
    if (!value) return "—";
    const locale = {
      "zh-cn": "zh-CN",
      "zh-tw": "zh-TW",
      en: "en",
      fr: "fr",
      ja: "ja"
    }[window.MrzhI18n.language()] || "zh-CN";
    return new Intl.DateTimeFormat(locale, {
      timeZone: configuredTimezone(),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(new Date(value));
  }

  function formatDateOnly(value) {
    if (!value) return "—";
    const locale = {
      "zh-cn": "zh-CN",
      "zh-tw": "zh-TW",
      en: "en",
      fr: "fr",
      ja: "ja"
    }[window.MrzhI18n.language()] || "zh-CN";
    return new Intl.DateTimeFormat(locale, {
      timeZone: configuredTimezone(),
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date(value));
  }

  function configuredTimezone() {
    return (
      state.bootstrap?.configBundle?.campConfig?.timezone ||
      "Asia/Shanghai"
    );
  }

  function zonedInputParts(value) {
    return Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: configuredTimezone(),
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
      })
        .formatToParts(value)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value])
    );
  }

  function setField(name, value) {
    const field = input(name);
    if (!field) return;
    if (field.type === "checkbox") field.checked = Boolean(value);
    else field.value = value ?? "";
  }

  function getField(name) {
    const field = input(name);
    return field?.type === "checkbox" ? field.checked : field?.value;
  }

  function setTechnologyVoteEnd(value) {
    const field = input("voteWindowEnd");
    if (!field) return;
    const isMidnight = value === "24:00";
    field.value = isMidnight ? "23:59" : value || "";
    field.dataset.legacyValue = isMidnight ? "24:00" : "";
  }

  function updateSaveState(fallback = "") {
    if (!state.dirtySections.size) {
      byId("save-state").textContent = translateUi(fallback);
      return;
    }
    byId("save-state").textContent =
      state.dirtySections.size === 1
        ? formatUi("有 {count} 个分区未保存", { count: 1 })
        : formatUi("有 {count} 个分区未保存", {
            count: state.dirtySections.size
          });
  }

  function renderTaskActions() {
    const root = byId("task-actions");
    root.replaceChildren();
    const tasks = (state.bootstrap?.plugins || [])
      .filter((plugin) => plugin.enabled)
      .flatMap((plugin) => plugin.tasks || []);
    for (const task of tasks) {
      const { key, name, description: copy, runPermission } = task;
      const card = create("article", "task-card");
      const button = create("button", "button button-primary", "立即执行");
      button.type = "button";
      button.disabled = !hasPermission(runPermission);
      button.addEventListener("click", () => runTask(key, button));
      card.append(
        create("h3", "", translateUi(name)),
        create("p", "", translateUi(copy)),
        button
      );
      root.append(card);
    }
  }

  function renderPermissionOptions() {
    const catalog = state.bootstrap?.permissionCatalog || [];
    for (const [rootId, name] of [
      ["key-permission-options", "keyPermission"],
      ["key-edit-permission-options", "keyEditPermission"]
    ]) {
      const root = byId(rootId);
      if (!root) continue;
      root.replaceChildren();
      for (const permission of catalog.filter((item) =>
        item.key === "system:admin" || item.key === "demo:preview" || item.key.startsWith("admin:") || item.key.startsWith("plugin:") || item.key === "technology-history:manage"
      )) {
        const label = create("label");
        const checkbox = create("input");
        checkbox.type = "checkbox";
        checkbox.name = name;
        checkbox.value = permission.key;
        checkbox.addEventListener("change", () => {
          const siblings = [...root.querySelectorAll(`input[name="${name}"]`)];
          if (checkbox.checked && checkbox.value === "system:admin") {
            siblings.forEach((item) => { if (item !== checkbox) item.checked = false; });
          } else if (checkbox.checked && checkbox.value !== "system:admin") {
            const system = siblings.find((item) => item.value === "system:admin");
            if (system) system.checked = false;
          }
        });
        label.append(
          checkbox,
          create("span", "", window.MrzhI18n.t(permission.label || permission.key))
        );
        root.append(label);
      }
    }
  }

  function renderWorkerPlugins() {
    const root = byId("worker-plugin-list");
    if (!root) return;
    root.replaceChildren();
    for (const plugin of state.bootstrap?.plugins || []) {
      const card = create("article", "agent-card");
      const heading = create("div", "agent-card-heading");
      heading.append(
        create("strong", "", `${translateUi(plugin.displayName)} · ${plugin.version} (Build ${plugin.build})`),
        create("span", plugin.enabled ? "agent-enabled-badge" : "agent-standby-badge", plugin.enabled ? "已启用" : "已停用")
      );
      const actions = create("div", "agent-card-actions");
      const toggle = create("button", plugin.enabled ? "button button-danger" : "button button-primary", plugin.enabled ? "停用" : "启用");
      toggle.type = "button";
      toggle.disabled = !hasPermission("plugins:manage");
      toggle.addEventListener("click", () => toggleWorkerPlugin(plugin, toggle));
      actions.append(toggle);
      card.append(
        heading,
        create("span", "agent-device-id", plugin.id),
        create("p", "", plugin.description),
        create(
          "span",
          "muted",
          formatUi("{tasks} 个任务 · {permissions} 项权限", {
            tasks: (plugin.tasks || []).length,
            permissions: (plugin.permissions || []).length
          })
        ),
        actions
      );
      root.append(card);
    }
  }

  async function toggleWorkerPlugin(plugin, button) {
    button.disabled = true;
    try {
      await request(`/api/admin/plugins/${encodeURIComponent(plugin.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !plugin.enabled })
      });
      await refresh(false);
    } catch (error) {
      byId("save-state").textContent = error.message;
      button.disabled = false;
    }
  }

  async function loadPluginClientModules() {
    for (const plugin of state.bootstrap?.plugins || []) {
      if (
        !plugin.enabled ||
        !plugin.clientModule ||
        state.loadedPluginClientModules.has(plugin.id)
      ) continue;
      try {
        const module = await import(plugin.clientModule);
        if (typeof module.mount === "function") {
          await module.mount({
            plugin,
            request,
            refresh: () => refresh(false),
            adminContent: document.querySelector(".admin-content"),
            adminNav: document.querySelector(".admin-nav")
          });
        }
        state.loadedPluginClientModules.add(plugin.id);
      } catch (error) {
        console.error(`Worker plugin client module failed: ${plugin.id}`, error);
      }
    }
  }

  function renderAgents(heartbeats) {
    const root = byId("agent-status");
    root.replaceChildren();
    if (!heartbeats?.length) {
      root.append(create("p", "empty-state", "尚未收到本地 Agent 心跳。"));
      return;
    }
    const activeAgentId = state.bootstrap?.configBundle?.campConfig?.agentId || "";
    for (const item of heartbeats) {
      const age = Date.now() - Date.parse(item.updated_at);
      const online =
        item.status !== "offline" &&
        Number.isFinite(age) &&
        age >= 0 &&
        age < (state.bootstrap?.agentOnlineThresholdSeconds || 45) * 1000;
      const card = create("article", "agent-card");
      if (item.agent_id === activeAgentId) card.dataset.active = "true";
      const heading = create("div", "agent-card-heading");
      heading.append(
        create("strong", "", item.display_name || item.agent_id),
        create(
          "span",
          item.agent_id === activeAgentId ? "agent-enabled-badge" : "agent-standby-badge",
          item.agent_id === activeAgentId ? "已启用" : "待命"
        )
      );
      const actions = create("div", "agent-card-actions");
      if (item.agent_id !== activeAgentId) {
        const activate = create("button", "button button-primary", "启用设备");
        activate.type = "button";
        activate.disabled = !hasPermission("admin:agent");
        activate.addEventListener("click", () => activateAgent(item, activate));
        const remove = create("button", "button button-danger", "删除设备");
        remove.type = "button";
        remove.disabled = !hasPermission("admin:agent");
        remove.addEventListener("click", () => deleteAgent(item, remove));
        actions.append(activate, remove);
      }
      card.append(
        heading,
        create(
          "span",
          "agent-device-id",
          window.MrzhI18n.format("设备 ID：{id}", { id: item.agent_id })
        ),
        create(
          "span",
          "agent-online-state",
          window.MrzhI18n.format("{agent} · {state}", {
            agent: item.status,
            state: window.MrzhI18n.t(online ? "在线" : "离线")
          })
        ),
        create(
          "span",
          "",
          item.active_task_key
            ? formatUi("{task} / {state}", {
                task: taskName(item.active_task_key),
                state: translateUi(online ? "在线" : "离线")
              })
            : window.MrzhI18n.format("空闲 / {date}", {
                date: formatDate(item.updated_at)
              })
        ),
        actions
      );
      root.append(card);
    }
  }

  async function activateAgent(item, button) {
    button.disabled = true;
    try {
      await request(
        `/api/admin/agents/${encodeURIComponent(item.agent_id)}/activate`,
        { method: "POST", body: "{}" }
      );
      byId("save-state").textContent = window.MrzhI18n.format(
        "已启用设备 {name}",
        { name: item.display_name || item.agent_id }
      );
      await refresh(false);
    } catch (error) {
      byId("save-state").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  async function deleteAgent(item, button) {
    const name = item.display_name || item.agent_id;
    if (!(await showAppConfirm(window.MrzhI18n.format(
      "确认删除设备 {name}？设备再次上线后会自动重新出现。",
      { name }
    ), { title: "删除设备", danger: true }))) return;
    button.disabled = true;
    try {
      await request(`/api/admin/agents/${encodeURIComponent(item.agent_id)}`, {
        method: "DELETE"
      });
      byId("save-state").textContent = window.MrzhI18n.format(
        "已删除设备 {name}",
        { name }
      );
      await refresh(false);
    } catch (error) {
      byId("save-state").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  function fillConfig(bundle, sections = CONFIG_SECTIONS) {
    const camp = bundle.campConfig;
    const overview = bundle.publicOverview;
    const automation = bundle.automationConfig;
    const tasks = automation.tasks;
    if (sections.includes("general")) {
      state.publicContentDraft = JSON.parse(
        JSON.stringify(overview.localized || {
          "zh-cn": { announcement: overview.announcement, highlights: overview.highlights },
          "zh-tw": { announcement: overview.announcement, highlights: overview.highlights },
          en: { announcement: overview.announcement, highlights: overview.highlights },
          fr: { announcement: overview.announcement, highlights: overview.highlights },
          ja: { announcement: overview.announcement, highlights: overview.highlights }
        })
      );
      for (const [name, value] of Object.entries({
        campName: camp.campName,
        serverName: camp.serverName,
        publicSiteName: camp.publicSiteName,
        timezone: automation.timezone,
        gameResetTime: camp.gameResetTime,
        specialDailyRefreshTime: camp.specialDailyRefreshTime || "00:00",
        publicMembersEnabled: camp.publicMembersEnabled,
        inactivityWarningDays: camp.inactivityWarningDays,
        temporaryKeyLoginEnabled: bundle.authConfig.temporaryKeyLoginEnabled,
        announcement:
          state.publicContentDraft[state.publicContentLocale]?.announcement || "",
        highlights: serializePublicHighlights(
          state.publicContentDraft[state.publicContentLocale]?.highlights || []
        )
      })) {
        setField(name, value);
      }
    }
    if (sections.includes("tasks")) {
      state.scheduleDrafts = {};
      state.scheduleWeekdayDrafts = {};
      state.scheduleReplacements = {};
      for (const [name, value] of Object.entries({
        scheduledRetryCount: automation.scheduledRetryCount ?? 2,
        manualRetryCount: automation.manualRetryCount ?? 0,
        techEnabled: tasks.tech_switch.enabled,
        techTime: tasks.tech_switch.time,
        contributionEnabled: tasks.contribution_sync.enabled,
        contributionTime: tasks.contribution_sync.time,
        inactivityEnabled: tasks.inactivity_sync.enabled,
        inactivityTime: tasks.inactivity_sync.time,
        profileEnabled: tasks.member_profile_sync.enabled,
        profileTime: tasks.member_profile_sync.time,
        weeklyActivityEnabled: tasks.weekly_activity_sync.enabled,
        weeklyActivityTime: tasks.weekly_activity_sync.time,
        patrolEnabled: tasks.patrol.enabled,
        patrolTime: tasks.patrol.time,
        patrolReadyTime: tasks.patrol.teamReadyTime,
        patrolDeadline: tasks.patrol.deadline,
        shareInterval: tasks.patrol.shareIntervalMinutes,
        chatPollSeconds: tasks.patrol.chatPollSeconds
      })) {
        setField(name, value);
      }
      for (const [taskKey, schedule] of Object.entries(tasks)) {
        state.scheduleDrafts[taskKey] = (schedule.times || [schedule.time]).slice();
        state.scheduleWeekdayDrafts[taskKey] = Array.isArray(schedule.weekdays) && schedule.weekdays.length
          ? schedule.weekdays.slice()
          : [1, 2, 3, 4, 5, 6, 7];
      }
      renderScheduleSummaries();
    }
    if (sections.includes("agent")) {
      for (const [name, value] of Object.entries({
        pollActiveSeconds: automation.agentPolling.activeSeconds,
        pollScheduledWindowMinutes: automation.agentPolling.scheduledWindowMinutes ?? 15,
        pollIdleSeconds: automation.agentPolling.idleSeconds,
        queueClaimTimeoutMinutes:
          automation.agentPolling.claimTimeoutMinutes,
        watchdogEnabled: automation.gameWatchdog.enabled,
        watchdogHealthSeconds: automation.gameWatchdog.healthCheckSeconds,
        watchdogActionSeconds: automation.gameWatchdog.actionTimeoutSeconds,
        watchdogFrozenSeconds: automation.gameWatchdog.frozenScreenSeconds,
        watchdogMaxRestarts: automation.gameWatchdog.maxRestarts,
        watchdogCooldownSeconds: automation.gameWatchdog.restartCooldownSeconds
      })) {
        setField(name, value);
      }
      byId("polling-windows-json").value = JSON.stringify(
        automation.agentPolling.windows,
        null,
        2
      );
    }
    if (sections.includes("technology")) {
      for (const [name, value] of Object.entries({
        voteWindowStart: camp.voteWindowStart || "06:30",
        currentCampType: camp.currentCampType
      })) {
        setField(name, value);
      }
      setTechnologyVoteEnd(camp.voteWindowEnd || "24:00");
      state.technologyDraft = JSON.parse(JSON.stringify(bundle.technologyConfig));
      ensureTechnologyPresets(state.technologyDraft);
      // Preset selection is an explicit UI action. Do not silently select the
      // first saved rule when the technology section is filled or refreshed.
      state.technologyPresetId = "";
      const limits = state.technologyDraft.limits || {};
      state.technologyDraft.limits = {
        core:
          Number.isInteger(limits.core) && limits.core >= 0 && limits.core <= 6
            ? limits.core
            : 6,
        general:
          Number.isInteger(limits.general) && limits.general >= 0 && limits.general <= 6
            ? limits.general
            : 6
      };
      const voteLimitInput = byId("technology-vote-limit");
      if (voteLimitInput) voteLimitInput.value = String(
        Number.isInteger(state.technologyDraft.voteLimit) ?
          state.technologyDraft.voteLimit :
          6
      );
      if (state.bootstrap?.voteSummary?.pollDate) {
        state.technologyDate = state.bootstrap.voteSummary.pollDate;
      }
      renderTechnologyEditor();
    }
    for (const section of sections) {
      const form = document.querySelector(
        `.config-form[data-config-section="${section}"]`
      );
      const feedback = form?.querySelector("[data-save-feedback]");
      if (feedback) feedback.textContent = translateUi("当前配置已同步");
    }
  }

  const SCHEDULE_FIELDS = {
    tech_switch: { enabled: "techEnabled", time: "techTime", title: "科技切换" },
    contribution_sync: { enabled: "contributionEnabled", time: "contributionTime", title: "更新贡献" },
    inactivity_sync: { enabled: "inactivityEnabled", time: "inactivityTime", title: "更新斩杀预警" },
    member_profile_sync: { enabled: "profileEnabled", time: "profileTime", title: "更新成员资料" },
    weekly_activity_sync: { enabled: "weeklyActivityEnabled", time: "weeklyActivityTime", title: "更新周活跃点" },
    patrol: { enabled: "patrolEnabled", time: "patrolTime", title: "营地巡逻" }
  };

  function scheduleTimes(taskKey) {
    const field = SCHEDULE_FIELDS[taskKey];
    const values = state.scheduleDrafts[taskKey];
    if (Array.isArray(values) && values.length) {
      const result = values.slice();
      const primary = document.querySelector(`[name="${field?.time || ""}"]`);
      if (primary) result[0] = String(primary.value || "").trim();
      return result;
    }
    const persisted =
      state.bootstrap?.configBundle?.automationConfig?.tasks?.[taskKey]?.times;
    if (Array.isArray(persisted) && persisted.length) return persisted.slice();
    return [String(getField(field?.time) || "").trim()];
  }

  const ALL_TASK_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

  function scheduleWeekdays(taskKey) {
    const values = state.scheduleWeekdayDrafts[taskKey];
    if (Array.isArray(values) && values.length) return values.slice();
    const persisted = state.bootstrap?.configBundle?.automationConfig?.tasks?.[taskKey]?.weekdays;
    return Array.isArray(persisted) && persisted.length
      ? persisted.slice()
      : ALL_TASK_WEEKDAYS.slice();
  }

  function scheduleWeekdayLabel(day) {
    return new Intl.DateTimeFormat(localeTag(), {
      weekday: "short",
      timeZone: "UTC"
    }).format(new Date(Date.UTC(2026, 0, 5 + day - 1, 12)));
  }

  function scheduleWeekdaySummary(taskKey) {
    const selected = scheduleWeekdays(taskKey);
    const days = selected.length === ALL_TASK_WEEKDAYS.length &&
      ALL_TASK_WEEKDAYS.every((day) => selected.includes(day))
      ? window.MrzhI18n.t("每天")
      : selected.map((day) => scheduleWeekdayLabel(day)).join("、");
    return window.MrzhI18n.format("执行日期：{days}", {
      days: days || window.MrzhI18n.t("未选择执行日")
    });
  }

  function renderScheduleWeekdayInputs() {
    const list = byId("schedule-weekday-list");
    const picker = list?.closest(".schedule-weekday-picker");
    const taskKey = state.scheduleDialogTaskKey;
    if (!list || !taskKey) return;
    if (picker) picker.hidden = false;
    const selected = new Set(scheduleWeekdays(taskKey));
    list.replaceChildren();
    for (const day of ALL_TASK_WEEKDAYS) {
      const label = create("label", "schedule-weekday-option");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = String(day);
      input.checked = selected.has(day);
      input.dataset.scheduleWeekday = "true";
      input.addEventListener("change", () => {
        const values = [...list.querySelectorAll("input[data-schedule-weekday]:checked")]
          .map((control) => Number(control.value));
        if (!values.length) {
          input.checked = true;
          byId("schedule-dialog-feedback").textContent = window.MrzhI18n.t("至少选择一天");
          return;
        }
        state.scheduleWeekdayDrafts[taskKey] = values;
        byId("schedule-dialog-feedback").textContent = "";
      });
      label.append(input, create("span", "", scheduleWeekdayLabel(day)));
      list.append(label);
    }
  }

  function renderScheduleSummaries() {
    for (const [taskKey, field] of Object.entries(SCHEDULE_FIELDS)) {
      const times = scheduleTimes(taskKey).filter(Boolean);
      const summary = document.querySelector(`[data-schedule-summary="${taskKey}"]`);
      if (summary) {
        summary.textContent = taskKey === "patrol"
          ? `${window.MrzhI18n.format("启动时间：{time}", { time: times[0] || window.MrzhI18n.t("未设置") })} · ${scheduleWeekdaySummary(taskKey)}`
          : `${window.MrzhI18n.format("执行 {count} 次：{times}", {
              count: times.length || 1,
              times: times.join("、") || window.MrzhI18n.t("未设置")
            })} · ${scheduleWeekdaySummary(taskKey)}`;
      }
      if (times[0]) setField(field.time, times[0]);
    }
  }

  function renderScheduleTimeInputs() {
    const list = byId("schedule-time-list");
    const add = byId("schedule-add-time");
    const taskKey = state.scheduleDialogTaskKey;
    const field = SCHEDULE_FIELDS[taskKey];
    if (!list || !field) return;
    const times = scheduleTimes(taskKey);
    list.replaceChildren();
    times.forEach((time, index) => {
      const row = create("div", "schedule-time-row");
      const label = create("label", "field");
      label.append(create("span", "", window.MrzhI18n.format("第 {number} 次执行时间", { number: index + 1 })));
      const control = document.createElement("input");
      control.type = "time";
      control.value = time || "";
      control.dataset.scheduleTime = "true";
      control.required = true;
      label.append(control);
      row.append(label);
      if (taskKey !== "tech_switch" && taskKey !== "patrol" && times.length > 1) {
        const remove = create("button", "button button-quiet", window.MrzhI18n.t("删除"));
        remove.type = "button";
        remove.addEventListener("click", () => {
          state.scheduleDrafts[taskKey].splice(index, 1);
          renderScheduleTimeInputs();
        });
        row.append(remove);
      }
      list.append(row);
    });
    if (add) {
      const singleRun = taskKey === "tech_switch" || taskKey === "patrol";
      add.hidden = singleRun;
      add.disabled = singleRun || times.length >= 12;
    }
  }

  function openScheduleDialog(taskKey) {
    const field = SCHEDULE_FIELDS[taskKey];
    const dialog = byId("schedule-dialog");
    if (!field || !dialog) return;
    state.scheduleDialogTaskKey = taskKey;
    state.scheduleDrafts[taskKey] = scheduleTimes(taskKey).slice();
    state.scheduleWeekdayDrafts[taskKey] = scheduleWeekdays(taskKey).slice();
    byId("schedule-dialog-title").textContent = `${window.MrzhI18n.t(field.title)}：${window.MrzhI18n.t("配置执行计划")}`;
    byId("schedule-dialog-note").textContent = taskKey === "patrol"
      ? window.MrzhI18n.t("巡逻任务只支持一个启动时间。")
      : taskKey === "tech_switch"
        ? window.MrzhI18n.t("科技切换任务只支持一个执行时间。")
        : window.MrzhI18n.t("默认保留当前时间。增加执行次数后，请分别设置每次执行时间。计划时间点后15分钟内提交的手动任务使用定时任务重试次数；其他手动任务使用手动任务失败重试次数。");
    byId("schedule-dialog-enabled").checked = Boolean(getField(field.enabled));
    const patrolFields = byId("schedule-patrol-fields");
    if (patrolFields) {
      patrolFields.hidden = taskKey !== "patrol";
      byId("schedule-dialog-patrol-ready").value = getField("patrolReadyTime") || "";
      byId("schedule-dialog-patrol-deadline").value = getField("patrolDeadline") || "";
      byId("schedule-dialog-share-interval").value = getField("shareInterval") || "";
      byId("schedule-dialog-chat-poll").value = getField("chatPollSeconds") || "";
    }
    byId("schedule-dialog-feedback").textContent = "";
    renderScheduleWeekdayInputs();
    renderScheduleTimeInputs();
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  function closeScheduleDialog() {
    const dialog = byId("schedule-dialog");
    if (!dialog) return;
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
    state.scheduleDialogTaskKey = null;
  }

  function addScheduleTime() {
    const taskKey = state.scheduleDialogTaskKey;
    if (!taskKey || taskKey === "tech_switch" || taskKey === "patrol") return;
    const times = scheduleTimes(taskKey);
    if (times.length >= 12) return;
    times.push("");
    state.scheduleDrafts[taskKey] = times;
    renderScheduleTimeInputs();
  }

  function saveScheduleDialog(event) {
    event.preventDefault();
    const taskKey = state.scheduleDialogTaskKey;
    const field = SCHEDULE_FIELDS[taskKey];
    if (!field) return;
    const times = [...byId("schedule-time-list").querySelectorAll("input[data-schedule-time]")]
      .map((control) => control.value.trim());
    const invalid = times.some((value) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(value));
    if (!times.length || invalid) {
      byId("schedule-dialog-feedback").textContent = window.MrzhI18n.t("请为每次执行填写有效时间。");
      return;
    }
    const weekdays = [...byId("schedule-weekday-list").querySelectorAll("input[data-schedule-weekday]:checked")]
      .map((control) => Number(control.value));
    if (!weekdays.length) {
      byId("schedule-dialog-feedback").textContent = window.MrzhI18n.t("至少选择一天");
      return;
    }
    const normalized = taskKey === "tech_switch" || taskKey === "patrol" ? [times[0]] : times;
    state.scheduleDrafts[taskKey] = normalized;
    state.scheduleWeekdayDrafts[taskKey] = weekdays;
    state.scheduleReplacements[taskKey] = true;
    setField(field.time, normalized[0]);
    setField(field.enabled, byId("schedule-dialog-enabled").checked);
    if (taskKey === "patrol") {
      setField("patrolReadyTime", byId("schedule-dialog-patrol-ready").value);
      setField("patrolDeadline", byId("schedule-dialog-patrol-deadline").value);
      setField("shareInterval", byId("schedule-dialog-share-interval").value);
      setField("chatPollSeconds", byId("schedule-dialog-chat-poll").value);
    }
    renderScheduleSummaries();
    state.dirtySections.add("tasks");
    document.querySelector('.config-form[data-config-section="tasks"] [data-save-feedback]')?.replaceChildren(document.createTextNode(translateUi("有未保存修改")));
    updateSaveState();
    closeScheduleDialog();
  }

  function renderVote(summary) {
    byId("next-tech-date").textContent = summary.pollDate || "--";
    const root = byId("admin-vote-summary");
    root.replaceChildren();
    root.append(
      create(
        "span",
        "vote-summary-item",
        window.MrzhI18n.format("{count} 人投票", {
          count: summary.ballotCount || 0
        })
      )
    );
    const canInspectVoters = canView("technology");
    const ballots = state.bootstrap?.voteBallots || [];
    for (const option of summary.options || []) {
      const item = create(
        canInspectVoters ? "button" : "span",
        `vote-summary-item${canInspectVoters ? " vote-summary-button" : ""}`,
        window.MrzhI18n.format("{name} · {votes} 票", {
          name: option.name,
          votes: option.votes
        })
      );
      if (canInspectVoters) {
        item.type = "button";
        item.addEventListener("click", () =>
          openVoteDetails(
            option,
            ballots.filter((ballot) =>
              (ballot.selections || []).includes(option.key)
            ),
            { source: "current", optionKey: option.key }
          )
        );
      }
      root.append(item);
    }
    refreshOpenVoteDetails("current");
  }

  function historyTechnologyItem(item, tag = "article", source = "") {
    const sourceClass = source ? ` technology-result-${source}` : "";
    const card = create(tag, `technology-history-tech${sourceClass}`);
    const icon = document.createElement(item.iconUrl ? "img" : "span");
    icon.className = "technology-history-tech-icon";
    if (item.iconUrl) {
      icon.src = item.iconUrl;
      icon.alt = "";
      icon.loading = "lazy";
    } else {
      icon.textContent = (item.name || "?").slice(0, 1);
    }
    card.append(icon, create("strong", "", item.name || "—"));
    return card;
  }

  function renderHistoryTechnologyList(root, items, emptyText) {
    root.replaceChildren();
    if (!items.length) {
      root.append(create("p", "technology-history-none", emptyText));
      return;
    }
    for (const item of items) root.append(historyTechnologyItem(item, "article", "fixed"));
  }

  function renderHistoryResultSlots(root, items, fixedKeys) {
    root.replaceChildren();
    for (let index = 0; index < 6; index += 1) {
      const item = items[index];
      const slot = create("div", "technology-fixed-slot");
      slot.dataset.filled = String(Boolean(item));
      slot.dataset.source = item
        ? fixedKeys.has(item.key)
          ? "fixed"
          : "vote"
        : "empty";
      slot.title = item
        ? window.MrzhI18n.format("{name} · {source}", {
            name: item.name,
            source: fixedKeys.has(item.key)
              ? window.MrzhI18n.t("固定科技")
              : window.MrzhI18n.t("投票科技")
          })
        : window.MrzhI18n.t("空位");
      if (item?.iconUrl) {
        const image = document.createElement("img");
        image.src = item.iconUrl;
        image.alt = item.name;
        image.loading = "lazy";
        slot.append(image);
      } else {
        slot.append(create("span", "", item ? item.name.slice(0, 1) : "+"));
      }
      root.append(slot);
    }
  }

  function renderTechnologyHistory(payload) {
    state.technologyHistory = payload || { dates: [], history: null, voteBallots: [] };
    const dates = state.technologyHistory.dates || [];
    const history = state.technologyHistory.history;
    const dateInput = byId("technology-history-date");
    const recentRoot = byId("technology-history-recent-dates");
    recentRoot.replaceChildren();
    if (!dates.length) {
      recentRoot.append(
        create("span", "technology-history-recent-empty", window.MrzhI18n.t("暂无历史结果"))
      );
    } else {
      for (const date of dates.slice(0, 7)) {
        const button = create(
          "button",
          "technology-history-date-chip",
          date.pollDate.slice(5)
        );
        button.type = "button";
        button.dataset.active = String(date.pollDate === history?.pollDate);
        button.title = window.MrzhI18n.format("{date} · {count} 人投票", {
          date: date.pollDate,
          count: date.ballotCount || 0
        });
        button.addEventListener("click", () => loadTechnologyHistory(date.pollDate));
        recentRoot.append(button);
      }
    }
    dateInput.value = history?.pollDate || dateInput.value || "";
    dateInput.disabled = state.technologyHistoryLoading;
    byId("refresh-technology-history").disabled = state.technologyHistoryLoading;
    byId("delete-technology-history-date").disabled =
      !history || !hasPermission("technology-history:manage");
    byId("delete-technology-history-all").disabled =
      !dates.length || !hasPermission("technology-history:manage");
    const content = byId("technology-history-content");
    const empty = byId("technology-history-empty");
    content.hidden = !history;
    empty.hidden = Boolean(history);
    if (!history) {
      refreshOpenVoteDetails("history");
      return;
    }
    byId("technology-history-ballots").textContent = window.MrzhI18n.format(
      "{count} 人最终投票",
      { count: history.ballotCount || 0 }
    );
    byId("technology-history-finalized").textContent = window.MrzhI18n.format(
      "按每日刷新归档于 {date}",
      { date: formatDate(history.finalizedAt) }
    );
    const fixedKeys = new Set(
      (history.fixedTechnologies || []).map((item) => item.key)
    );
    renderHistoryResultSlots(
      byId("technology-history-core"),
      history.projectedPlan?.core || [],
      fixedKeys
    );
    renderHistoryResultSlots(
      byId("technology-history-general"),
      history.projectedPlan?.general || [],
      fixedKeys
    );
    renderHistoryTechnologyList(
      byId("technology-history-fixed"),
      history.fixedTechnologies || [],
      window.MrzhI18n.t("当天未设置固定科技")
    );
    const votes = byId("technology-history-votes");
    votes.replaceChildren();
    const voted = (history.options || []).filter((item) => Number(item.votes) > 0);
    const ballots = state.technologyHistory.voteBallots || [];
    if (!voted.length) {
      votes.append(
        create("p", "technology-history-none", window.MrzhI18n.t("当天没有有效投票"))
      );
    } else {
      for (const item of voted) {
        const row = create(
          "button",
          "technology-history-vote technology-history-vote-button"
        );
        row.type = "button";
        row.title = window.MrzhI18n.t("查看投票人详情");
        row.addEventListener("click", () =>
          openVoteDetails(
            item,
            ballots.filter((ballot) =>
              (ballot.selections || []).includes(item.key)
            ),
            { source: "history", pollDate: history.pollDate, optionKey: item.key }
          )
        );
        row.append(
          historyTechnologyItem(item, "span", "voted"),
          create(
            "strong",
            "technology-history-vote-count",
            window.MrzhI18n.format("{count} 票", { count: item.votes })
          )
        );
        votes.append(row);
      }
    }
    refreshOpenVoteDetails("history");
  }

  async function loadTechnologyHistory(date = "") {
    if (!canView("technology-history")) return;
    if (state.technologyHistoryLoading) {
      state.technologyHistoryReloadQueued = true;
      state.technologyHistoryReloadDate = date;
      return;
    }
    state.technologyHistoryLoading = true;
    byId("technology-history-status").textContent = window.MrzhI18n.t(
      "正在读取历史记录…"
    );
    try {
      const params = new URLSearchParams({
        locale: window.MrzhI18n.language()
      });
      if (date) params.set("date", date);
      const payload = await request(`/api/admin/technology-history?${params}`);
      renderTechnologyHistory(payload);
      state.technologyHistoryLoaded = true;
      byId("technology-history-status").textContent = payload.history
        ? window.MrzhI18n.t("已载入最终归档")
        : window.MrzhI18n.t("暂无可查询记录");
    } catch (error) {
      byId("technology-history-status").textContent = error.message;
    } finally {
      state.technologyHistoryLoading = false;
      state.technologyHistoryLoaded = true;
      renderTechnologyHistory(state.technologyHistory);
      if (state.technologyHistoryReloadQueued) {
        const queuedDate = state.technologyHistoryReloadDate;
        state.technologyHistoryReloadQueued = false;
        state.technologyHistoryReloadDate = "";
        void loadTechnologyHistory(queuedDate);
      }
    }
  }

  async function deleteTechnologyHistory(date) {
    const deletingAll = !date;
    const label = deletingAll
      ? window.MrzhI18n.t("全部历史投票结果")
      : window.MrzhI18n.format("{date} 的历史投票结果", { date });
    if (!(await showAppConfirm(
      window.MrzhI18n.format("确认删除{label}吗？删除后无法从后台恢复。", { label }),
      { title: deletingAll ? "删除全部历史" : "删除所选日", danger: true }
    ))) return;
    const button = byId(
      deletingAll
        ? "delete-technology-history-all"
        : "delete-technology-history-date"
      );
      button.disabled = true;
    try {
      const suffix = date ? `?date=${encodeURIComponent(date)}` : "";
      const result = await request(`/api/admin/technology-history${suffix}`, {
        method: "DELETE"
      });
      byId("technology-history-status").textContent = window.MrzhI18n.format(
        "已删除 {count} 条历史结果。",
        { count: result.deleted || 0 }
      );
      state.technologyHistoryLoaded = false;
      await loadTechnologyHistory();
    } catch (error) {
      byId("technology-history-status").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  function dailyBlocksFromText(value) {
    return parsePublicHighlights(value).flatMap((item) => item.blocks);
  }

  function dailyBlocksToText(blocks) {
    return (blocks || [])
      .map((block) => block.type === "image"
        ? `![${block.alt || ""}](${block.url})`
        : String(block.text || ""))
      .join("\n");
  }

  function dailyLocalDateTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const parts = zonedInputParts(date);
    const pad = (part) => String(part).padStart(2, "0");
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
  }

  function dailyOptionLabel(option) {
    const text = (option?.blocks || [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join(" ")
      .trim();
    return text || (option?.blocks || []).some((block) => block.type === "image")
      ? text || window.MrzhI18n.t("图片选项")
      : window.MrzhI18n.t("未命名选项");
  }

  function dailyContentForAdmin(item) {
    return item?.localizedContent?.[window.MrzhI18n.language()] ||
      item?.localizedContent?.["zh-cn"] ||
      Object.values(item?.localizedContent || {})[0] ||
      { titleBlocks: [], descriptionBlocks: [], options: [] };
  }

  function renderDailyVoteAdmin(payload, mode = "active") {
    const history = mode === "history";
    const view = history
      ? {
          rootId: "daily-vote-history-admin-list",
          statusId: "daily-vote-history-status",
          pageId: "daily-vote-history-page",
          prevId: "daily-vote-history-prev",
          nextId: "daily-vote-history-next",
          jumpId: "daily-vote-history-jump",
          pageKey: "dailyVoteHistoryPage",
          totalKey: "dailyVoteHistoryTotal"
        }
      : {
          rootId: "daily-vote-admin-list",
          statusId: "daily-vote-status",
          pageId: "daily-vote-page",
          prevId: "daily-vote-prev",
          nextId: "daily-vote-next",
          jumpId: "daily-vote-jump",
          pageKey: "dailyVotePage",
          totalKey: "dailyVoteTotal"
        };
    state.dailyVoteItems = payload?.items || [];
    state.dailyVoteItemsByMode[mode] = state.dailyVoteItems;
    if (!history) state.dailyVoteConfig = payload?.config || state.dailyVoteConfig;
    state[view.pageKey] = Number(payload?.page) || 1;
    state[view.totalKey] = Number(payload?.total) || 0;
    const maxWinsInput = byId("daily-vote-max-wins-28-days");
    if (!history && maxWinsInput && document.activeElement !== maxWinsInput) {
      maxWinsInput.value = String(state.dailyVoteConfig.drawMaxWins28Days ?? 4);
    }
    if (!history) {
      const eligibility = state.dailyVoteConfig.voteEligibility || {};
      const enabled = byId("vote-eligibility-enabled");
      if (enabled && document.activeElement !== enabled) {
        enabled.checked = state.dailyVoteConfig.voteEligibilityEnabled !== false;
      }
      for (const [id, key, fallback] of [
        ["vote-eligibility-min-contribution", "weeklyContribution", 1500],
        ["vote-eligibility-min-technology-points", "technologyPoints", 0],
        ["vote-eligibility-min-materials", "materialContribution", 50000],
        ["vote-eligibility-min-weekly-activity", "weeklyActivityPoints", 25]
      ]) {
        const input = byId(id);
        if (input && document.activeElement !== input) input.value = String(eligibility[key] ?? fallback);
      }
    }
    const root = byId(view.rootId);
    if (!root) return;
    root.replaceChildren();
    if (!state.dailyVoteItems.length) {
      root.append(create(
        "p",
        "empty-state",
        history ? "暂无已结束日常投票事项记录。" : "暂无日常投票事项记录。"
      ));
    } else for (const item of state.dailyVoteItems) {
      const content = dailyContentForAdmin(item);
      const card = create("article", "daily-vote-admin-card");
      const heading = create("div", "daily-vote-admin-heading");
      const title = create("div", "daily-vote-admin-title");
      title.textContent = (content.titleBlocks || [])
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(" ") || window.MrzhI18n.t("未命名事项");
      const actions = create("div", "daily-vote-admin-actions");
      if (!history) {
        const edit = create("button", "button button-quiet button-small", "编辑");
        edit.type = "button";
        edit.addEventListener("click", () => openDailyVoteEditor(item));
        const remove = create("button", "button button-danger button-small", "删除选中记录");
        remove.type = "button";
        remove.addEventListener("click", () => deleteDailyVoteItemAdmin(item.id));
        actions.append(edit, remove);
      }
      const titleGroup = create("div", "daily-vote-admin-title-group");
      titleGroup.append(title, create("span", "daily-vote-kind", item.kind === "draw" ? "抽签事项" : "投票事项"));
      heading.append(titleGroup);
      if (actions.childElementCount) heading.append(actions);
      card.append(heading);
      card.append(create(
        "p",
        "daily-vote-admin-meta",
        window.MrzhI18n.format(
          item.kind === "draw"
            ? "开放 {start} · 截止 {end} · 批次号 {batchNumber}"
            : "开放 {start} · 截止 {end}",
          {
            start: formatDate(item.startAt),
            end: formatDate(item.endAt),
            batchNumber: item.batchNumber || "0"
          }
        )
      ));
      if (item.kind === "poll") {
        const counts = new Map();
        for (const response of item.responses || []) {
          for (const optionId of response.selections || []) counts.set(optionId, (counts.get(optionId) || 0) + 1);
        }
        const optionList = create("div", "daily-vote-admin-options");
        for (const option of content.options || []) {
          const optionButton = create(
            "button",
            "daily-history-result daily-vote-admin-option",
            window.MrzhI18n.format("{option} · {count} 票", {
              option: dailyOptionLabel(option),
              count: counts.get(option.id) || 0
            })
          );
          optionButton.type = "button";
          optionButton.title = window.MrzhI18n.t("查看该选项的投票人详情");
          optionButton.addEventListener("click", () =>
            openDailyVoteDetails(
              dailyOptionLabel(option),
              window.MrzhI18n.format(
                "共 {count} 份投票；每个识别码在单个开放投票期只计一份提交记录。",
                { count: counts.get(option.id) || 0 }
              ),
              (item.responses || [])
                .filter((response) => (response.selections || []).includes(option.id))
                .map((response) => ({
                  identityCode: response.identityCode,
                  playerName: response.playerName,
                  votedAt: response.submittedAt
                })),
              { mode, type: "poll-option", itemId: item.id, optionId: option.id }
            )
          );
          optionList.append(optionButton);
        }
        card.append(optionList);
      } else {
        const detailActions = create("div", "daily-vote-admin-details");
        const participants = create("button", "button button-quiet daily-vote-admin-detail-button", "抽签参与人员");
        participants.type = "button";
        participants.addEventListener("click", () =>
          openDailyVoteDetails(
            "抽签参与人员",
            window.MrzhI18n.format(
              "共 {count} 人报名；同一识别码重复报名时仅保留最后一次提交。",
              { count: (item.responses || []).length }
            ),
            (item.responses || []).map((response) => ({
              identityCode: response.identityCode,
              playerName: response.playerName,
              votedAt: response.submittedAt
            })),
            { mode, type: "draw-participants", itemId: item.id }
          )
        );
        const winners = create("button", "button button-quiet daily-vote-admin-detail-button", "抽签中签人员");
        winners.type = "button";
        winners.addEventListener("click", () =>
          openDailyVoteDetails(
            "抽签中签人员",
            window.MrzhI18n.format("共 {count} 人中签。", { count: (item.winners || []).length }),
            (item.winners || []).map((winner) => ({
              identityCode: winner.identityCode,
              playerName: `${winner.rank}. ${winner.playerName}`
            })),
            { mode, type: "draw-winners", itemId: item.id }
          )
        );
        detailActions.append(participants, winners);
        card.append(detailActions);
      }
      root.append(card);
    }
    const page = state[view.pageKey];
    const pages = Math.max(1, Math.ceil(state[view.totalKey] / 10));
    setText(view.pageId, `${page} / ${pages}`);
    byId(view.prevId).disabled = page <= 1;
    byId(view.nextId).disabled = page >= pages;
    byId(view.jumpId).max = String(pages);
    byId(view.jumpId).value = String(page);
    refreshOpenDailyVoteDetails(mode);
  }

  async function loadDailyVoteAdmin(date = "", page = state.dailyVotePage, mode = "active") {
    const history = mode === "history";
    if (!canView("daily-vote")) return;
    if (state.dailyVoteLoading) {
      state.dailyVoteReloadRequest = { date, page, mode };
      return;
    }
    state.dailyVoteLoading = true;
    setText(history ? "daily-vote-history-status" : "daily-vote-status", window.MrzhI18n.t("正在读取历史记录…"));
    try {
      const requestedPage = Number(page);
      const params = new URLSearchParams({
        locale: window.MrzhI18n.language(),
        page: String(Number.isFinite(requestedPage) ? Math.max(1, Math.trunc(requestedPage)) : 1),
        status: history ? "history" : "active"
      });
      if (history && date) params.set("date", date);
      const payload = await request(`/api/admin/daily-vote?${params}`);
      renderDailyVoteAdmin(payload, mode);
      setText(history ? "daily-vote-history-status" : "daily-vote-status", window.MrzhI18n.t("记录已载入"));
    } catch (error) {
      setText(history ? "daily-vote-history-status" : "daily-vote-status", error.message);
    } finally {
      state.dailyVoteLoading = false;
      const queued = state.dailyVoteReloadRequest;
      state.dailyVoteReloadRequest = null;
      if (queued) void loadDailyVoteAdmin(queued.date, queued.page, queued.mode);
    }
  }

  async function saveDailyVoteConfig(event) {
    event.preventDefault();
    setText("daily-vote-config-feedback", "");
    try {
      const payload = await request("/api/admin/daily-vote/config", {
        method: "PUT",
        body: JSON.stringify({
          drawMaxWins28Days: Number(byId("daily-vote-max-wins-28-days").value),
          voteEligibilityEnabled: byId("vote-eligibility-enabled").checked,
          voteEligibility: {
            weeklyContribution: Number(byId("vote-eligibility-min-contribution").value),
            technologyPoints: Number(byId("vote-eligibility-min-technology-points").value),
            materialContribution: Number(byId("vote-eligibility-min-materials").value),
            weeklyActivityPoints: Number(byId("vote-eligibility-min-weekly-activity").value)
          }
        })
      });
      state.dailyVoteConfig = payload.config || state.dailyVoteConfig;
      byId("daily-vote-max-wins-28-days").value = String(state.dailyVoteConfig.drawMaxWins28Days);
      setText("daily-vote-config-feedback", window.MrzhI18n.t("通用投票设置已保存"));
    } catch (error) {
      setText("daily-vote-config-feedback", localizeDailyVoteError(error));
    }
  }

  function toggleDailyVoteEditorFields() {
    const isDraw = byId("daily-vote-kind")?.value === "draw";
    byId("daily-vote-max-field").hidden = isDraw;
    byId("daily-vote-draw-field").hidden = !isDraw;
    byId("daily-vote-draw-batch-field").hidden = !isDraw;
    byId("daily-vote-draw-limit-field").hidden = !isDraw;
    byId("daily-vote-options-field").hidden = isDraw;
    byId("daily-vote-options").required = !isDraw;
    byId("daily-vote-draw-batch").required = isDraw;
  }

  function localizeDailyVoteError(error) {
    const raw = error?.message || String(error || "");
    const translated = window.MrzhI18n?.t ? window.MrzhI18n.t(raw) : raw;
    if (translated !== raw) return translated;
    if (/^localizedContent\.[^.]+\.options must contain between 2 and 50 options$/.test(raw)) {
      return window.MrzhI18n.t("投票选项至少需要 2 个，最多 50 个。");
    }
    return raw;
  }

  function openDailyVoteEditor(item = null, kind = "poll") {
    state.dailyVoteEditorItem = item;
    setText("daily-vote-editor-feedback", "");
    const source = item || {
      kind,
      startAt: "",
      endAt: "",
      revealBeforeSeconds: 0,
      maxSelections: 1,
      drawCount: 1,
      batchNumber: "0",
      drawLimitEnabled: true,
      localizedContent: { "zh-cn": { titleBlocks: [], descriptionBlocks: [], options: [] } }
    };
    const content = dailyContentForAdmin(source);
    byId("daily-vote-id").value = item?.id || "";
    byId("daily-vote-kind").value = source.kind;
    byId("daily-vote-start").value = dailyLocalDateTime(source.startAt);
    byId("daily-vote-end").value = dailyLocalDateTime(source.endAt);
    byId("daily-vote-reveal-value").value = source.revealBeforeSeconds ? Math.round(source.revealBeforeSeconds / 3600) : 0;
    byId("daily-vote-reveal-unit").value = source.revealBeforeSeconds >= 86400 ? "86400" : source.revealBeforeSeconds >= 3600 ? "3600" : "60";
    byId("daily-vote-max").value = source.maxSelections || 1;
    byId("daily-vote-draw-count").value = source.drawCount || 1;
    byId("daily-vote-draw-batch").value = source.batchNumber ?? "0";
    byId("daily-vote-draw-limit-enabled").checked = source.drawLimitEnabled !== false;
    byId("daily-vote-eligibility-enabled").checked = source.eligibilityCheckEnabled !== false;
    byId("daily-vote-title-blocks").value = dailyBlocksToText(content.titleBlocks);
    byId("daily-vote-description-blocks").value = dailyBlocksToText(content.descriptionBlocks);
    byId("daily-vote-options").value = (content.options || []).map((option) => dailyBlocksToText(option.blocks)).join("\n\n");
    byId("daily-vote-editor-title").textContent = item ? "编辑日常事项" : source.kind === "draw" ? "新建抽签" : "新建投票";
    byId("daily-vote-editor").hidden = false;
    toggleDailyVoteEditorFields();
    byId("daily-vote-title-blocks").focus();
  }

  function closeDailyVoteEditor() {
    state.dailyVoteEditorItem = null;
    byId("daily-vote-editor").hidden = true;
    setText("daily-vote-editor-feedback", "");
  }

  async function saveDailyVoteFromEditor(event) {
    event.preventDefault();
    setText("daily-vote-editor-feedback", "");
    const kind = byId("daily-vote-kind").value;
    const existing = state.dailyVoteEditorItem;
    const options = kind === "poll"
      ? parsePublicHighlights(byId("daily-vote-options").value).map((entry) => ({ id: crypto.randomUUID(), blocks: entry.blocks }))
      : [];
    const content = {
      titleBlocks: dailyBlocksFromText(byId("daily-vote-title-blocks").value),
      descriptionBlocks: dailyBlocksFromText(byId("daily-vote-description-blocks").value),
      options
    };
    if (existing) {
      const previous = dailyContentForAdmin(existing);
      const previousIds = (previous.options || []).map((option) => option.id);
      options.forEach((option, index) => { option.id = previousIds[index] || option.id; });
    }
    const payload = {
      kind,
      localizedContent: {
        ...(existing?.localizedContent || {}),
        "zh-cn": content
      },
      startAtLocal: byId("daily-vote-start").value,
      endAtLocal: byId("daily-vote-end").value,
      revealBeforeSeconds: Number(byId("daily-vote-reveal-value").value || 0) * Number(byId("daily-vote-reveal-unit").value || 60),
      batchNumber: byId("daily-vote-draw-batch").value.trim(),
      drawLimitEnabled: byId("daily-vote-draw-limit-enabled").checked,
      eligibilityCheckEnabled: byId("daily-vote-eligibility-enabled").checked,
      ...(kind === "poll"
        ? { maxSelections: Number(byId("daily-vote-max").value || 1) }
        : { drawCount: Number(byId("daily-vote-draw-count").value || 1) })
    };
    try {
      await request(existing ? `/api/admin/daily-vote/${encodeURIComponent(existing.id)}` : "/api/admin/daily-vote", {
        method: existing ? "PATCH" : "POST",
        body: JSON.stringify(payload)
      });
      closeDailyVoteEditor();
      await loadDailyVoteAdmin("", 1, "active");
    } catch (error) {
      setText("daily-vote-editor-feedback", localizeDailyVoteError(error));
    }
  }

  async function deleteDailyVoteItemAdmin(id) {
    if (!(await showAppConfirm(window.MrzhI18n.t("确认删除选中的日常事项吗？删除后无法恢复。"), { title: "删除选中记录", danger: true }))) return;
    try {
      await request(`/api/admin/daily-vote/${encodeURIComponent(id)}`, { method: "DELETE" });
      await loadDailyVoteAdmin("", 1, "active");
    } catch (error) {
      setText("daily-vote-status", error.message);
    }
  }

  async function deleteDailyVoteHistoryAdmin(date = "") {
    const all = !date;
    if (!(await showAppConfirm(
      window.MrzhI18n.t(all ? "确认清空全部已结束日常事项吗？清空后无法恢复。" : `确认清空 ${date} 的已结束日常事项吗？`),
      { title: all ? "清空全部历史" : "清空当天历史", danger: true }
    ))) return;
    try {
      const suffix = date ? `?date=${encodeURIComponent(date)}` : "";
      const result = await request(`/api/admin/daily-vote${suffix}`, { method: "DELETE" });
      setText("daily-vote-history-status", window.MrzhI18n.format("已清空 {count} 条记录。", { count: result.deleted || 0 }));
      await loadDailyVoteAdmin(date, 1, "history");
    } catch (error) {
      setText("daily-vote-history-status", error.message);
    }
  }

  function openVoteDetails(option, ballots, context = {}) {
    state.activeDailyVoteDetail = null;
    state.activeVoteDetail = {
      source: context.source || "current",
      optionKey: context.optionKey || option.key,
      pollDate: context.pollDate || ""
    };
    renderVoteDetails(
      option.name,
      window.MrzhI18n.format(
        "共 {count} 份投票；每个识别码在单个开放投票期只计一份提交记录。",
        { count: ballots.length }
      ),
      ballots
    );
    byId("vote-detail-dialog").showModal();
  }

  function refreshOpenVoteDetails(source) {
    const dialog = byId("vote-detail-dialog");
    const active = state.activeVoteDetail;
    if (!dialog?.open || !active || active.source !== source) return;
    const summary = source === "current"
      ? state.bootstrap?.voteSummary
      : state.technologyHistory?.history;
    if (source === "history" && active.pollDate !== summary?.pollDate) return;
    const option = (summary?.options || []).find((item) => item.key === active.optionKey);
    if (!option) return;
    const ballots = source === "current"
      ? state.bootstrap?.voteBallots || []
      : state.technologyHistory?.voteBallots || [];
    const entries = ballots.filter((ballot) =>
      (ballot.selections || []).includes(active.optionKey)
    );
    renderVoteDetails(
      option.name,
      window.MrzhI18n.format(
        "共 {count} 份投票；每个识别码在单个开放投票期只计一份提交记录。",
        { count: entries.length }
      ),
      entries
    );
  }

  function renderVoteDetails(title, summary, entries) {
    byId("vote-detail-title").textContent = window.MrzhI18n.t(title);
    byId("vote-detail-summary").textContent = summary;
    const root = byId("vote-detail-list");
    root.replaceChildren();
    if (!entries.length) {
      root.append(create("p", "empty-state", window.MrzhI18n.t("暂无投票记录")));
    } else {
      for (const entry of entries) {
        const item = create("article", "vote-detail-item");
        const identity = create("code", "vote-detail-code", entry.identityCode || "—");
        const player = create("strong", "vote-detail-player", entry.playerName || "—");
        const time = create(
          "time",
          "muted",
          formatVoteDate(entry.votedAt || entry.submittedAt || entry.selectedAt)
        );
        item.append(identity, player, time);
        root.append(item);
      }
    }
  }

  function openDailyVoteDetails(title, summary, entries, context) {
    state.activeVoteDetail = null;
    state.activeDailyVoteDetail = context || null;
    renderVoteDetails(title, summary, entries);
    byId("vote-detail-dialog").showModal();
  }

  function refreshOpenDailyVoteDetails(mode) {
    const dialog = byId("vote-detail-dialog");
    const active = state.activeDailyVoteDetail;
    if (!dialog?.open || !active || active.mode !== mode) return;
    const item = (state.dailyVoteItemsByMode[mode] || []).find(
      (entry) => entry.id === active.itemId
    );
    if (!item) return;
    let title = "";
    let summary = "";
    let entries = [];
    if (active.type === "poll-option") {
      const option = (dailyContentForAdmin(item).options || []).find(
        (entry) => entry.id === active.optionId
      );
      if (!option) return;
      title = dailyOptionLabel(option);
      entries = (item.responses || [])
        .filter((response) => (response.selections || []).includes(active.optionId))
        .map((response) => ({
          identityCode: response.identityCode,
          playerName: response.playerName,
          votedAt: response.submittedAt
        }));
      summary = window.MrzhI18n.format(
        "共 {count} 份投票；每个识别码在单个开放投票期只计一份提交记录。",
        { count: entries.length }
      );
    } else if (active.type === "draw-participants") {
      title = "抽签参与人员";
      entries = (item.responses || []).map((response) => ({
        identityCode: response.identityCode,
        playerName: response.playerName,
        votedAt: response.submittedAt
      }));
      summary = window.MrzhI18n.format(
        "共 {count} 人报名；同一识别码重复报名时仅保留最后一次提交。",
        { count: entries.length }
      );
    } else if (active.type === "draw-winners") {
      title = "抽签中签人员";
      entries = (item.winners || []).map((winner) => ({
        identityCode: winner.identityCode,
        playerName: `${winner.rank}. ${winner.playerName}`
      }));
      summary = window.MrzhI18n.format("共 {count} 人中签。", { count: entries.length });
    }
    renderVoteDetails(title, summary, entries);
  }

  function datePlusDays(dateKey, days) {
    const date = new Date(`${dateKey}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  function technologyFirstDate() {
    return (
      state.bootstrap?.voteSummary?.pollDate ||
      state.bootstrap?.nextTechnologyTargetDate ||
      identityExpiryDate(new Date())
    );
  }

  function technologyDateDifference(startDate, endDate) {
    return Math.round(
      (new Date(`${endDate}T12:00:00Z`).getTime() -
        new Date(`${startDate}T12:00:00Z`).getTime()) /
        (24 * 60 * 60 * 1000)
    );
  }

  function weekdayForTechnologyDate(date) {
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    return weekday === 0 ? 7 : weekday;
  }

  function technologyPresetApplies(preset, targetDate) {
    if (preset.mode === "date") return preset.date === targetDate;
    if (!preset.startDate || targetDate < preset.startDate) return false;
    if (preset.endDate && targetDate > preset.endDate) return false;
    if (preset.mode === "weekday") {
      return (preset.weekdays || []).includes(weekdayForTechnologyDate(targetDate));
    }
    const intervalDays = Number(preset.intervalDays);
    const elapsed = technologyDateDifference(preset.startDate, targetDate);
    return Number.isInteger(intervalDays) && intervalDays >= 0 &&
      elapsed >= 0 && elapsed % (intervalDays + 1) === 0;
  }

  function fixedTechnologyKeysForDate(config, targetDate) {
    const presets = Array.isArray(config.fixedPresets)
      ? config.fixedPresets
      : [];
    if (presets.length) {
      const exact = presets.filter(
        (preset) => preset.mode === "date" && technologyPresetApplies(preset, targetDate)
      );
      const active = exact.length
        ? exact
        : presets.filter(
            (preset) => preset.mode !== "date" && technologyPresetApplies(preset, targetDate)
          );
      return [...new Set(active.flatMap((preset) => preset.technologyKeys || []))];
    }
    return [
      ...(config.fixedByDate?.[targetDate] ||
        config.fixedByWeekday?.[String(weekdayForTechnologyDate(targetDate))] ||
        [])
    ];
  }

  function createTechnologyPresetId() {
    if (globalThis.crypto?.randomUUID) {
      return `preset-${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
    }
    return `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function createEmptyTechnologyPreset() {
    return {
      id: createTechnologyPresetId(),
      mode: "date",
      date: state.technologyDate || technologyFirstDate(),
      // Always allocate a fresh empty array. A new rule must never inherit
      // technology keys from the currently selected rule or from the catalog.
      technologyKeys: []
    };
  }

  function ensureTechnologyPresets(config) {
    if (Array.isArray(config.fixedPresets)) return config.fixedPresets;
    const presets = [];
    for (const [date, technologyKeys] of Object.entries(config.fixedByDate || {})) {
      if (technologyKeys?.length) {
        presets.push({
          id: `legacy-date-${date}`,
          mode: "date",
          date,
          technologyKeys: [...technologyKeys]
        });
      }
    }
    for (let weekday = 1; weekday <= 7; weekday += 1) {
      const technologyKeys = config.fixedByWeekday?.[String(weekday)] || [];
      if (technologyKeys.length) {
        presets.push({
          id: `legacy-weekday-${weekday}`,
          mode: "weekday",
          startDate: "1970-01-01",
          endDate: null,
          weekdays: [weekday],
          technologyKeys: [...technologyKeys]
        });
      }
    }
    config.fixedPresets = presets;
    return presets;
  }

  function technologyWeekdayLabel(weekday) {
    return new Intl.DateTimeFormat(localeTag(), {
      weekday: "short",
      timeZone: "UTC"
    }).format(new Date(`2026-06-${String(weekday).padStart(2, "0")}T12:00:00Z`));
  }

  function technologyPresetModeLabel(mode) {
    return {
      date: "指定日期",
      weekday: "按星期循环",
      interval: "按间隔循环"
    }[mode] || "固定规则";
  }

  function technologyPresetTitle(preset) {
    if (preset.mode === "date") return `指定日期 · ${preset.date || "未设置"}`;
    if (preset.mode === "weekday") {
      const weekdays = (preset.weekdays || []).map(technologyWeekdayLabel).join("、");
      return `每周 ${weekdays || "未选择星期"}`;
    }
    return `每隔 ${Number(preset.intervalDays) || 0} 个科技日`;
  }

  function technologyPresetRange(preset) {
    if (preset.mode === "date") return preset.date || "未设置日期";
    return `${preset.startDate || "未设置起始日"} — ${preset.endDate || "永久有效"}`;
  }

  function selectedTechnologyPreset() {
    return state.technologyDraft?.fixedPresets?.find(
      (preset) => preset.id === state.technologyPresetId
    ) || null;
  }

  function selectedTechnologyPresetIsLocked(preset) {
    const summary = state.bootstrap?.voteSummary;
    return Boolean(
      preset && summary?.isOpen === false &&
      technologyPresetApplies(preset, summary.pollDate)
    );
  }

  function markTechnologyDirty() {
    state.dirtySections.add("technology");
    updateSaveState();
    const feedback = document
      .querySelector('[data-config-section="technology"]')
      ?.querySelector("[data-save-feedback]");
    if (feedback) feedback.textContent = translateUi("科技配置尚未保存");
  }

  function discardTechnologyDraft() {
    const bundle = state.bootstrap?.configBundle;
    if (!bundle?.technologyConfig) {
      state.technologyPresetId = "";
      return;
    }
    fillConfig(bundle, ["technology"]);
    state.dirtySections.delete("technology");
    updateSaveState();
  }

  function renderTechnologyPresetList() {
    const config = state.technologyDraft;
    const root = byId("technology-preset-list");
    root.replaceChildren();
    if (!config.fixedPresets.length) {
      root.append(create("p", "technology-preset-empty", "暂无固定规则，点击右上角新建。"));
      return;
    }
    for (const preset of config.fixedPresets) {
      const button = create("button", "technology-preset-item");
      button.type = "button";
      button.dataset.active = String(preset.id === state.technologyPresetId);
      const main = create("span", "technology-preset-item-main");
      main.append(
        create("strong", "", technologyPresetTitle(preset)),
        create("small", "", technologyPresetRange(preset))
      );
      const meta = create("span", "technology-preset-item-meta");
      meta.append(
        create("span", "technology-preset-mode", technologyPresetModeLabel(preset.mode)),
        create("span", "technology-preset-count", `${preset.technologyKeys.length} 项`)
      );
      button.append(main, meta);
      button.setAttribute(
        "aria-pressed",
        String(preset.id === state.technologyPresetId)
      );
      button.addEventListener("click", () => {
        const isSelected = preset.id === state.technologyPresetId;
        state.technologyPresetId = isSelected ? "" : preset.id;
        if (!isSelected && preset.mode === "date" && preset.date) {
          state.technologyDate = preset.date;
        }
        if (!isSelected && preset.mode !== "date" && preset.startDate) {
          state.technologyDate = preset.startDate;
        }
        renderTechnologyEditor();
      });
      root.append(button);
    }
  }

  function setTechnologyPresetMode(preset, mode) {
    if (mode === preset.mode) return;
    const firstDate = technologyFirstDate();
    if (mode === "date") {
      preset.date = preset.date || preset.startDate || firstDate;
    } else {
      preset.startDate = preset.startDate || preset.date || firstDate;
      preset.endDate ??= null;
      if (mode === "weekday") {
        preset.weekdays = preset.weekdays?.length
          ? preset.weekdays
          : [weekdayForTechnologyDate(preset.startDate)];
      } else {
        preset.intervalDays = Number.isInteger(preset.intervalDays)
          ? preset.intervalDays
          : 1;
      }
    }
    preset.mode = mode;
  }

  function renderTechnologyPresetEditor() {
    const config = state.technologyDraft;
    const preset = selectedTechnologyPreset();
    const empty = byId("technology-rule-empty");
    const form = byId("technology-rule-form");
    empty.hidden = Boolean(preset);
    form.hidden = !preset;
    if (!preset) return;
    const locked = selectedTechnologyPresetIsLocked(preset);
    byId("technology-rule-title").textContent = technologyPresetTitle(preset);
    byId("technology-delete-preset").disabled = locked;
    const lockHint = byId("technology-rule-lock-hint");
    lockHint.hidden = !locked;
    lockHint.textContent = locked
      ? "当前投票已锁定，刷新前不能改动命中今天的规则"
      : "";
    const fields = byId("technology-rule-fields");
    fields.replaceChildren();

    const modeLabel = create("span", "field-label", "生效方式");
    const modeGroup = create("div", "technology-rule-modes");
    for (const [mode, label] of [
      ["date", "指定日期"],
      ["weekday", "按星期循环"],
      ["interval", "按间隔循环"]
    ]) {
      const button = create("button", "technology-rule-mode", label);
      button.type = "button";
      button.dataset.active = String(preset.mode === mode);
      button.setAttribute("aria-pressed", String(preset.mode === mode));
      button.disabled = locked;
      button.addEventListener("click", () => {
        setTechnologyPresetMode(preset, mode);
        markTechnologyDirty();
        renderTechnologyEditor();
      });
      modeGroup.append(button);
    }
    fields.append(modeLabel, modeGroup);

    if (preset.mode === "date") {
      const dateField = create("label", "field technology-rule-date-field");
      dateField.append(create("span", "", "科技生效日"));
      const input = document.createElement("input");
      input.type = "date";
      input.value = preset.date || technologyFirstDate();
      input.required = true;
      input.disabled = locked;
      input.addEventListener("change", () => {
        preset.date = input.value;
        state.technologyDate = input.value;
        markTechnologyDirty();
        renderTechnologyEditor();
      });
      dateField.append(input);
      fields.append(dateField);
    } else {
      const range = create("div", "technology-rule-date-range");
      const startField = create("label", "field");
      startField.append(create("span", "", "起始生效日"));
      const startInput = document.createElement("input");
      startInput.type = "date";
      startInput.value = preset.startDate || technologyFirstDate();
      startInput.required = true;
      startInput.disabled = locked;
      startInput.addEventListener("change", () => {
        preset.startDate = startInput.value;
        if (preset.endDate && preset.endDate < preset.startDate) preset.endDate = preset.startDate;
        markTechnologyDirty();
        renderTechnologyEditor();
      });
      startField.append(startInput);
      const endField = create("label", "field");
      endField.append(create("span", "", "结束生效日"));
      const endInput = document.createElement("input");
      endInput.type = "date";
      endInput.value = preset.endDate || "";
      endInput.min = preset.startDate || technologyFirstDate();
      endInput.disabled = locked || preset.endDate === null;
      endInput.addEventListener("change", () => {
        preset.endDate = endInput.value || null;
        markTechnologyDirty();
        renderTechnologyEditor();
      });
      endField.append(endInput);
      range.append(startField, endField);
      const permanentLabel = create("label", "technology-permanent-toggle");
      const permanent = document.createElement("input");
      permanent.type = "checkbox";
      permanent.checked = preset.endDate === null;
      permanent.disabled = locked;
      permanent.addEventListener("change", () => {
        preset.endDate = permanent.checked
          ? null
          : preset.endDate || preset.startDate || technologyFirstDate();
        markTechnologyDirty();
        renderTechnologyEditor();
      });
      permanentLabel.append(permanent, document.createTextNode(" 永久有效"));
      fields.append(range, permanentLabel);

      if (preset.mode === "weekday") {
        const weekdayField = create("div", "technology-rule-weekdays");
        weekdayField.append(create("span", "field-label", "每周生效日（可多选）"));
        const weekdayChoices = create("div", "technology-weekday-choices");
        for (let weekday = 1; weekday <= 7; weekday += 1) {
          const label = create("label", "technology-weekday-choice");
          const input = document.createElement("input");
          input.type = "checkbox";
          input.checked = (preset.weekdays || []).includes(weekday);
          input.disabled = locked;
          input.addEventListener("change", () => {
            const next = new Set(preset.weekdays || []);
            if (input.checked) next.add(weekday);
            else next.delete(weekday);
            preset.weekdays = [...next].sort((left, right) => left - right);
            markTechnologyDirty();
            renderTechnologyEditor();
          });
          label.append(input, document.createTextNode(technologyWeekdayLabel(weekday)));
          weekdayChoices.append(label);
        }
        weekdayField.append(weekdayChoices);
        fields.append(weekdayField);
      } else {
        const intervalField = create("label", "field technology-interval-field");
        intervalField.append(create("span", "", "每隔几个科技日开放"));
        const intervalInput = document.createElement("input");
        intervalInput.type = "number";
        intervalInput.min = "0";
        intervalInput.max = "3650";
        intervalInput.step = "1";
        intervalInput.value = String(Number.isInteger(preset.intervalDays) ? preset.intervalDays : 1);
        intervalInput.required = true;
        intervalInput.disabled = locked;
        intervalInput.addEventListener("change", () => {
          preset.intervalDays = Number(intervalInput.value);
          markTechnologyDirty();
          renderTechnologyEditor();
        });
        intervalField.append(intervalInput, create("small", "field-hint", "填 1 时按 6 月 1 日、3 日、5 日……生效"));
        fields.append(intervalField);
      }
    }
    const count = byId("technology-rule-selection-count");
    count.textContent = preset.technologyKeys.length
      ? `${preset.technologyKeys.length} 项科技 · 请在下方目录勾选`
      : "尚未选择科技 · 请在下方目录勾选";
  }

  function renderTechnologyPreview(config, campType, effectiveLane) {
    const firstDate = technologyFirstDate();
    const weekdayRoot = byId("technology-weekdays");
    weekdayRoot.replaceChildren();
    if (!state.technologyDate) state.technologyDate = firstDate;
    if (state.technologyDate < firstDate) state.technologyDate = firstDate;
    const dateInput = byId("technology-fixed-date");
    if (dateInput) {
      dateInput.min = firstDate;
      if (document.activeElement !== dateInput) dateInput.value = state.technologyDate;
    }
    for (let index = 0; index < 7; index += 1) {
      const date = datePlusDays(firstDate, index);
      const weekday = new Intl.DateTimeFormat(localeTag(), {
        weekday: "short",
        timeZone: "UTC"
      }).format(new Date(`${date}T00:00:00Z`));
      const name = `${index === 0 ? `${translateUi("次日")} · ` : ""}${date.slice(5)} ${weekday}`;
      const button = create("button", "weekday-tab", name);
      button.type = "button";
      button.dataset.active = String(state.technologyDate === date);
      button.addEventListener("click", () => {
        state.technologyDate = date;
        renderTechnologyEditor();
      });
      weekdayRoot.append(button);
    }

    const fixed = new Set(fixedTechnologyKeysForDate(config, state.technologyDate));
    const currentVoteSummary = state.bootstrap?.voteSummary;
    const previewRoot = byId("technology-fixed-preview");
    previewRoot.replaceChildren();
    const showsCurrentProjection = state.technologyDate === currentVoteSummary?.pollDate;
    const projectedOrderByLane = new Map(
      ["core", "general"].map((lane) => [
        lane,
        showsCurrentProjection
          ? (currentVoteSummary?.projectedPlan?.[lane] || []).map((item) => item.key)
          : []
      ])
    );
    for (const lane of ["core", "general"]) {
      const projectedOrder = projectedOrderByLane.get(lane);
      const projectedKeys = new Set(projectedOrder);
      const selected = config.catalog
        .filter((item) => showsCurrentProjection
          ? projectedKeys.has(item.key)
          : fixed.has(item.key) && effectiveLane(item) === lane)
        .sort((a, b) => showsCurrentProjection
          ? projectedOrder.indexOf(a.key) - projectedOrder.indexOf(b.key)
          : a.sortOrder - b.sortOrder);
      const limit = config.limits[lane];
      const visibleSelected = selected.slice(0, limit);
      const laneRoot = create("section", "technology-fixed-lane");
      const laneHeader = create("div", "technology-fixed-lane-header");
      laneHeader.append(
        create("strong", "", technologyRowLabel(lane, campType)),
        create("span", "", `${visibleSelected.length} / ${limit}`)
      );
      const slots = create("div", "technology-fixed-slots");
      for (let index = 0; index < TECHNOLOGY_ROW_SLOT_COUNT; index += 1) {
        const item = visibleSelected[index];
        const slot = create("div", "technology-fixed-slot");
        slot.dataset.filled = String(Boolean(item));
        slot.dataset.source = item ? fixed.has(item.key) ? "fixed" : "vote" : "empty";
        slot.title = item
          ? formatUi("{name} · {source}", {
              name: item.name,
              source: fixed.has(item.key) ? translateUi("固定科技") : translateUi("投票科技")
            })
          : window.MrzhI18n.t("空位");
        if (item?.iconUrl) {
          const image = document.createElement("img");
          image.src = item.iconUrl;
          image.alt = item.name;
          image.loading = "lazy";
          slot.append(image);
        } else if (item) slot.append(create("span", "", item.name.slice(0, 1)));
        else slot.append(create("span", "", "+"));
        slots.append(slot);
      }
      laneRoot.append(laneHeader, slots);
      previewRoot.append(laneRoot);
    }
  }

  function renderTechnologyCatalog(config, campType, effectiveLane) {
    const root = byId("technology-catalog-grid");
    root.replaceChildren();
    byId("technology-empty").hidden = Boolean(config.catalog.length);
    const normalizedQuery = state.technologyQuery.trim().toLocaleLowerCase();
    const filteredCatalog = config.catalog.filter((item) => {
      if (state.technologyCategory !== "all" && item.category !== state.technologyCategory) return false;
      if (!normalizedQuery) return true;
      return [item.name, item.description, item.uiLabel].filter(Boolean).some((value) =>
        String(value).toLocaleLowerCase().includes(normalizedQuery)
      );
    });
    byId("technology-filter-empty").hidden = !config.catalog.length || Boolean(filteredCatalog.length);
    byId("technology-result-count").textContent = window.MrzhI18n.format(
      "显示 {count} / {total} 项科技",
      { count: filteredCatalog.length, total: config.catalog.length }
    );
    const preset = selectedTechnologyPreset();
    const fixed = new Set(
      preset && Array.isArray(preset.technologyKeys)
        ? preset.technologyKeys
        : []
    );
    const presetLocked = selectedTechnologyPresetIsLocked(preset);
    const currentVoteSummary = state.bootstrap?.voteSummary;
    const technologyResultLocked = Boolean(
      currentVoteSummary?.isOpen === false &&
      state.technologyDate === currentVoteSummary.pollDate
    );
    const coreLabel = technologyCategoryLabel(campType);
    const otherLabel = translateUi("其他科技");
    for (const item of [...filteredCatalog].sort((a, b) => a.sortOrder - b.sortOrder)) {
      const card = create("article", "technology-admin-card");
      card.dataset.fixed = String(fixed.has(item.key));
      const image = document.createElement(item.iconUrl ? "img" : "span");
      image.className = "tech-icon technology-admin-icon";
      if (item.iconUrl) {
        image.src = item.iconUrl;
        image.alt = "";
        image.loading = "lazy";
      } else image.textContent = item.name.slice(0, 1);
      const copy = create("div", "technology-admin-copy");
      copy.append(
        create("strong", "", item.name),
        create("small", "", `${categoryLabel(item.category)} · ${technologyRowLabel(effectiveLane(item), campType)}`),
        create("p", "", item.description || translateUi("暂无科技描述"))
      );
      const controls = create("div", "technology-admin-controls");
      const fixedLabel = create("label", "technology-toggle");
      const fixedInput = document.createElement("input");
      fixedInput.type = "checkbox";
      fixedInput.checked = fixed.has(item.key);
      fixedInput.disabled = !preset || presetLocked;
      fixedInput.title = !preset
        ? "请先新建或选择固定规则"
        : presetLocked
          ? "当前投票已锁定，刷新前不能改动命中今天的规则"
          : "将科技加入当前固定规则";
      fixedInput.addEventListener("change", () => {
        if (!preset) return;
        const keys = new Set(preset.technologyKeys || []);
        if (fixedInput.checked) {
          const itemLane = effectiveLane(item);
          const laneCount = config.catalog.filter((technology) =>
            keys.has(technology.key) && effectiveLane(technology) === itemLane
          ).length;
          const limit = config.limits[itemLane];
          if (laneCount >= limit) {
            fixedInput.checked = false;
            void showAppAlert(formatUi("{lane}最多固定 {limit} 项", {
              lane: itemLane === "core" ? coreLabel : otherLabel,
              limit
            }), { title: "操作" });
            return;
          }
          keys.add(item.key);
        } else keys.delete(item.key);
        preset.technologyKeys = [...keys];
        markTechnologyDirty();
        renderTechnologyEditor();
      });
      fixedLabel.append(fixedInput, document.createTextNode(` ${translateUi("固定到此规则")}`));
      const voteLabel = create("label", "technology-toggle");
      const voteInput = document.createElement("input");
      voteInput.type = "checkbox";
      voteInput.checked = item.enabledForVoting;
      voteInput.disabled = technologyResultLocked;
      voteInput.title = technologyResultLocked
        ? translateUi("投票截止后至每日刷新前不可修改当前投票配置")
        : "";
      voteInput.addEventListener("change", () => {
        item.enabledForVoting = voteInput.checked;
        markTechnologyDirty();
      });
      voteLabel.append(voteInput, document.createTextNode(` ${translateUi("开放投票")}`));
      const laneSelect = document.createElement("select");
      laneSelect.className = "technology-lane-select";
      const coreOption = document.createElement("option");
      coreOption.value = "core";
      coreOption.textContent = technologyRowLabel("core", campType);
      const otherOption = document.createElement("option");
      otherOption.value = "general";
      otherOption.textContent = technologyRowLabel("general", campType);
      laneSelect.append(coreOption, otherOption);
      laneSelect.value = effectiveLane(item);
      laneSelect.disabled = true;
      laneSelect.title = translateUi("科技所在行由营地科技类型自动决定");
      controls.append(fixedLabel, voteLabel, laneSelect);
      card.append(image, copy, controls);
      root.append(card);
    }
  }

  function renderTechnologyEditor() {
    const config = state.technologyDraft;
    if (!config) return;
    config.limits ||= { core: 6, general: 6 };
    config.limits.core = Number.isInteger(config.limits.core)
      ? Math.max(0, Math.min(6, config.limits.core))
      : 6;
    config.limits.general = Number.isInteger(config.limits.general)
      ? Math.max(0, Math.min(6, config.limits.general))
      : 6;
    const voteLimitInput = byId("technology-vote-limit");
    if (voteLimitInput && document.activeElement !== voteLimitInput) {
      voteLimitInput.value = String(
        Number.isInteger(config.voteLimit) ? config.voteLimit : 6
      );
    }
    const eligibilityInput = byId("technology-vote-eligibility-enabled");
    if (eligibilityInput && document.activeElement !== eligibilityInput) {
      eligibilityInput.checked = config.voteEligibilityEnabled !== false;
    }
    for (const [id, lane] of [
      ["technology-core-limit", "core"],
      ["technology-general-limit", "general"]
    ]) {
      const limitInput = byId(id);
      if (limitInput && document.activeElement !== limitInput) {
        limitInput.value = String(config.limits[lane]);
      }
    }
    ensureTechnologyPresets(config);
    const campType = state.bootstrap?.configBundle?.campConfig?.currentCampType || "agriculture";
    const effectiveLane = (item) => item.category === campType ? "core" : "general";
    if (state.technologyPresetId && !selectedTechnologyPreset()) {
      state.technologyPresetId = "";
    }
    renderTechnologyPresetList();
    renderTechnologyPresetEditor();
    renderTechnologyPreview(config, campType, effectiveLane);
    renderTechnologyCatalog(config, campType, effectiveLane);
  }

  function categoryLabel(category) {
    const source = {
      agriculture: "农业",
      military: "军事",
      industry: "工业"
    }[category];
    return translateUi(source || category);
  }

  function technologyCategorySource(category) {
    return {
      agriculture: "农业科技",
      military: "军事科技",
      industry: "工业科技"
    }[category] || "其他科技";
  }

  function technologyCategoryLabel(category) {
    return translateUi(technologyCategorySource(category));
  }

  function technologyRowLabel(lane, campType) {
    const source = lane === "core"
      ? `${technologyCategorySource(campType)}行`
      : "其他科技行";
    return translateUi(source);
  }

  function localeTag() {
    return {
      "zh-cn": "zh-CN",
      "zh-tw": "zh-TW",
      en: "en",
      fr: "fr",
      ja: "ja"
    }[window.MrzhI18n.language()] || "zh-CN";
  }

  function renderRuns(runs) {
    const root = byId("run-table");
    const activeTrigger = state.runActionMenu?.trigger;
    const replacingActiveTrigger = Boolean(activeTrigger && root.contains(activeTrigger));
    root.replaceChildren();
    if (replacingActiveTrigger) closeRunActionMenu();
    for (const run of runs || []) {
      const row = document.createElement("tr");
      row.append(
        create("td", "run-time", formatDate(run.finished_at || run.created_at)),
        create("td", "", taskName(run.task_key)),
        create("td", `status-${run.state}`, stateName(run.state)),
        create("td", "numeric", `${Math.round((run.progress || 0) * 100)}%`),
        create("td", "", run.message || "—")
      );
      const actions = create("td", "run-actions");
      const operation = createRunActionButton(
        "操作",
        "button-quiet run-action-trigger",
        "operation"
      );
      operation.setAttribute("aria-haspopup", "menu");
      operation.setAttribute("aria-expanded", "false");
      operation.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleRunActionMenu(run, operation);
      });
      actions.append(operation);
      row.append(actions);
      root.append(row);
    }
  }

  function openMaintenanceDialog(action) {
    const rateLimits = action === "rate-limits";
    state.maintenanceAction = action;
    byId("maintenance-dialog-title").textContent = window.MrzhI18n.t(
      rateLimits ? "清空临时限流？" : "清理任务运行记录？"
    );
    byId("maintenance-dialog-message").textContent = window.MrzhI18n.t(
      rateLimits
        ? "将删除当前公开接口的临时失败计数并立即解除误封，不会修改识别码或申请资料。"
        : "只删除已结束任务及其事件，不影响排队中或运行中的任务。"
    );
    byId("maintenance-confirm").classList.toggle(
      "button-primary",
      rateLimits
    );
    byId("maintenance-confirm").classList.toggle(
      "button-danger",
      !rateLimits
    );
    byId("maintenance-feedback").textContent = "";
    byId("maintenance-dialog").showModal();
  }

  async function confirmMaintenance() {
    if (!state.maintenanceAction) return;
    const action = state.maintenanceAction;
    const button = byId("maintenance-confirm");
    button.disabled = true;
    byId("maintenance-feedback").textContent = window.MrzhI18n.t("正在清理…");
    try {
      const result = await request(
        `/api/admin/maintenance/${action}`,
        { method: "DELETE" }
      );
      const count =
        action === "rate-limits"
          ? result.deleted
          : result.totalDeleted;
      byId("maintenance-feedback").textContent = window.MrzhI18n.format(
        "清理完成：已删除 {count} 条记录。",
        { count: count ?? 0 }
      );
      if (action === "run-history") {
        await refresh(false);
      }
    } catch (error) {
      byId("maintenance-feedback").textContent =
        error.message || window.MrzhI18n.t("维护操作失败");
    } finally {
      button.disabled = false;
    }
  }

  function closeRunActionMenu() {
    const active = state.runActionMenu;
    if (!active) return;
    active.trigger?.setAttribute("aria-expanded", "false");
    active.menu.remove();
    state.runActionMenu = null;
    if (state.identityListRefreshQueued) {
      state.identityListRefreshQueued = false;
      if (state.activeView === "identity-applications") {
        void loadIdentityApplications();
      } else if (state.activeView === "identity-codes") {
        void loadIdentityCodes();
      }
    }
  }

  function positionRunActionMenu() {
    const active = state.runActionMenu;
    if (!active) return;
    if (!active.trigger?.isConnected || !active.menu?.isConnected) {
      closeRunActionMenu();
      return;
    }

    const { menu, trigger } = active;
    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const edge = 8;
    const gap = 8;
    const menuHeight = Math.min(menuRect.height, viewportHeight - edge * 2);
    const belowTop = triggerRect.bottom + gap;
    const aboveTop = triggerRect.top - gap - menuHeight;
    const top = belowTop + menuHeight <= viewportHeight - edge
      ? belowTop
      : aboveTop >= edge
        ? aboveTop
        : Math.max(edge, Math.min(belowTop, viewportHeight - edge - menuHeight));
    const left = Math.max(
      edge,
      Math.min(triggerRect.right - menuRect.width, viewportWidth - edge - menuRect.width)
    );

    menu.style.top = `${Math.round(top)}px`;
    menu.style.left = `${Math.round(left)}px`;
    menu.style.visibility = "visible";
  }

  function toggleRunActionMenu(run, trigger) {
    const cancellationPending = run.state === "cancelling";
    toggleActionMenu(trigger, [
      {
        label: "事件",
        icon: "events",
        onSelect: () => showEvents(run.id)
      },
      {
        label: cancellationPending ? "终止已提交" : "终止任务",
        icon: "stop",
        danger: true,
        disabled:
          !ACTIVE_STATES.has(run.state) ||
          cancellationPending ||
          !hasPermission("task:interrupt"),
        onSelect: (button) => interruptRun(run.id, button)
      }
    ]);
  }

  function toggleActionMenu(trigger, entries) {
    if (state.runActionMenu?.trigger === trigger) {
      closeRunActionMenu();
      return;
    }
    closeRunActionMenu();
    const menu = create("div", "run-action-menu");
    menu.setAttribute("role", "menu");
    for (const entry of entries) {
      const button = createRunActionButton(
        entry.label,
        `${entry.danger ? "button-danger" : "button-quiet"} run-action-menu-item`,
        entry.icon || "events"
      );
      button.setAttribute("role", "menuitem");
      button.disabled = Boolean(entry.disabled);
      button.addEventListener("click", () => {
        closeRunActionMenu();
        entry.onSelect(button);
      });
      menu.append(button);
    }
    menu.addEventListener("click", (event) => event.stopPropagation());
    menu.style.visibility = "hidden";
    document.body.append(menu);
    trigger.setAttribute("aria-expanded", "true");
    state.runActionMenu = { menu, trigger };
    positionRunActionMenu();
  }

  function activateView(view) {
    const availableViews = new Set(
      [...document.querySelectorAll("[data-admin-view]")].map(
        (element) => element.dataset.adminView
      )
    );
    const resolved =
      availableViews.has(view) && canView(view)
        ? view
        : [...availableViews].find((candidate) => canView(candidate)) || "overview";
    const viewChanged = state.activeView !== resolved;
    if (viewChanged) closeRunActionMenu();
    if (state.activeView === "technology" && resolved !== "technology") {
      if (state.dirtySections.has("technology")) {
        discardTechnologyDraft();
      } else {
        state.technologyPresetId = "";
        renderTechnologyEditor();
      }
    }
    state.activeView = resolved;
    for (const element of document.querySelectorAll("[data-admin-view]")) {
      element.hidden =
        element.dataset.adminView !== resolved ||
        !canView(element.dataset.adminView);
    }
    for (const link of document.querySelectorAll("[data-nav-target]")) {
      const active = link.dataset.navTarget === resolved;
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    const preserveOpenIdentityMenu =
      !viewChanged &&
      state.runActionMenu?.trigger?.isConnected &&
      (state.activeView === "identity-applications" || state.activeView === "identity-codes");
    if (
      resolved === "identity-applications" &&
      canView(resolved) &&
      !preserveOpenIdentityMenu
    ) {
      loadIdentityApplications();
    }
    if (
      resolved === "identity-codes" &&
      canView(resolved) &&
      !preserveOpenIdentityMenu
    ) {
      loadIdentityCodes();
    }
    if (resolved === "smtp" && canView(resolved)) {
      loadSmtpConfig();
    }
    if (resolved === "access" && canView(resolved)) loadTemporaryKeys();
    if (
      resolved === "technology-history" &&
      canView(resolved) &&
      !state.technologyHistoryLoaded
    ) {
      loadTechnologyHistory();
    }
  }

  function mountVoteAdminCards() {
    const managementGrid = document.querySelector(
      "#vote-management-shell .vote-admin-card-grid"
    );
    const historyShell = byId("vote-history-shell");
    const historyGrid = historyShell?.querySelector(".vote-admin-card-grid");
    if (managementGrid && historyShell && historyGrid && historyShell.parentElement) {
      while (historyGrid.firstElementChild) {
        managementGrid.append(historyGrid.firstElementChild);
      }
      historyShell.remove();
    }
    const move = (selector, hostId, removeViewAttribute = false) => {
      const source = document.querySelector(selector);
      const host = byId(hostId);
      if (!source || !host || source.parentElement === host) return source;
      if (removeViewAttribute) {
        source.removeAttribute("data-admin-view");
        source.removeAttribute("hidden");
      }
      host.append(source);
      return source;
    };
    move(
      '.config-form[data-config-section="technology"]',
      "vote-management-technology-host"
    );
    move(
      "#daily-vote-management-admin",
      "vote-management-daily-host",
      true
    );
    move(
      ".technology-history[data-admin-view=\"technology-history\"]",
      "vote-history-technology-host",
      true
    );

    for (const card of document.querySelectorAll("[data-vote-management-card]")) {
      if (card.dataset.voteCardBound) continue;
      card.dataset.voteCardBound = "true";
      card.addEventListener("toggle", () => {
        if (!card.open) return;
        if (card.dataset.voteManagementCard === "general") {
          void loadDailyVoteAdmin("", state.dailyVotePage, "active");
        } else if (card.dataset.voteManagementCard === "daily-vote") {
          void loadDailyVoteAdmin("", 1, "active");
        }
      });
    }
    for (const card of document.querySelectorAll("[data-vote-history-card]")) {
      if (card.dataset.voteCardBound) continue;
      card.dataset.voteCardBound = "true";
      card.addEventListener("toggle", () => {
        if (!card.open) return;
        if (card.dataset.voteHistoryCard === "technology") {
          state.technologyHistoryLoaded = false;
          void loadTechnologyHistory();
        } else {
          void loadDailyVoteAdmin(
            byId("daily-vote-history-date")?.value || "",
            1,
            "history"
          );
        }
      });
    }
  }

  function render(data, fillSections = []) {
    mountVoteAdminCards();
    state.bootstrap = data;
    document.documentElement.dataset.timezone =
      data.configBundle?.campConfig?.timezone || "Asia/Shanghai";
    if (!input("keyExpiresAt")?.value) setDefaultKeyExpiry();
    const identityExpiryInput = input("identityExpiresAt");
    if (identityExpiryInput && !identityExpiryInput.value) {
      identityExpiryInput.value = identityExpiryDate();
    }
    state.csrfToken = data.session.csrfToken;
    renderPermissionOptions();
    renderTaskActions();
    renderWorkerPlugins();
    void loadPluginClientModules();
    const enabledTasks = new Set(
      (data.plugins || [])
        .filter((plugin) => plugin.enabled)
        .flatMap((plugin) => (plugin.tasks || []).map((task) => task.key))
    );
    for (const card of document.querySelectorAll("[data-plugin-task]")) {
      card.hidden = !enabledTasks.has(card.dataset.pluginTask);
    }
    byId("session-email").textContent =
      data.session.displayName || data.session.email;
    document.body.dataset.readonly = String(
      (data.session.permissions || []).includes("demo:preview") &&
        !(data.session.permissions || []).includes("*")
    );
    byId("next-tech-date").textContent = data.nextTechnologyTargetDate || "--";
    if (canView("overview")) renderAgents(data.heartbeats || []);
    if (canView("technology")) renderVote(data.voteSummary || { options: [] });
    if (canView("history")) renderRuns(data.recentRuns || []);
    if (canView("members")) {
      renderAdminMembers(data.members || []);
      const listedMemberCount = data.members?.length || 0;
      const reportedMemberCount = Number(data.memberSummary?.expectedCount);
      const totalMemberCount = Number.isInteger(reportedMemberCount) && reportedMemberCount >= 0
        ? reportedMemberCount
        : listedMemberCount;
      setText(
        "admin-member-count",
        `当前列表 ${listedMemberCount} / 总人数 ${totalMemberCount}`
      );
    }
    state.accessAllowed = canView("access");
    for (const link of document.querySelectorAll("[data-nav-target]")) {
      link.hidden = !canView(link.dataset.navTarget);
    }
    if (fillSections.length) {
      fillConfig(
        data.configBundle,
        fillSections.filter((section) => canView(section))
      );
    }
    setConfigReadOnly();
    setModuleActionState();
    const requestedView = location.hash.slice(1) || state.activeView;
    activateView(requestedView);
  }

  function setConfigReadOnly() {
    for (const form of document.querySelectorAll(".config-form")) {
      const readonly = !hasPermission(VIEW_PERMISSIONS[form.dataset.configSection]);
      for (const field of form.querySelectorAll(
        "input, select, textarea, button"
      )) {
        const uiOnly = field.matches("[data-ui-only]") || field.closest("[data-ui-only]");
        field.disabled =
          (!uiOnly && readonly) ||
          (state.saving && field.matches('button[type="submit"]'));
      }
    }
    const canManageTasks = hasPermission("admin:tasks");
    for (const control of byId("schedule-dialog-form")?.querySelectorAll("input, button") || []) {
      control.disabled = !canManageTasks || state.saving;
    }
  }

  function setModuleActionState() {
    for (const [selector, permission] of [
      ["#temporary-key-form input, #temporary-key-form button", "keys:manage"],
      ["#manual-identity-code-form input, #manual-identity-code-form select, #manual-identity-code-form button", "identity:manage"],
      ["#smtp-config-form input, #smtp-config-form select, #smtp-config-form button, #smtp-test-form input, #smtp-test-form button", "smtp:manage"],
      ["#daily-vote-new-poll, #daily-vote-new-draw, #daily-vote-config-form input, #daily-vote-config-form button, #daily-vote-editor input, #daily-vote-editor select, #daily-vote-editor textarea, #daily-vote-editor button", "admin:daily-vote"],
      ["#member-edit-identity-code", "identity:manage"]
    ]) {
      for (const control of document.querySelectorAll(selector)) {
        control.disabled = !hasPermission(permission);
      }
    }
    byId("clear-rate-limits").disabled = !hasPermission("admin:history");
    byId("clear-run-history").disabled = !hasPermission("admin:history");
    for (const control of document.querySelectorAll("#delete-daily-vote-history-date, #delete-daily-vote-history-all")) {
      control.disabled = !hasPermission("admin:daily-vote");
    }
    const canManageTechnologyHistory = hasPermission("technology-history:manage");
    byId("delete-technology-history-date").hidden = !canManageTechnologyHistory;
    byId("delete-technology-history-all").hidden = !canManageTechnologyHistory;
    byId("delete-technology-history-date").disabled =
      !canManageTechnologyHistory || !state.technologyHistory.history;
    byId("delete-technology-history-all").disabled =
      !canManageTechnologyHistory || !(state.technologyHistory.dates || []).length;
    const canManageMembers = hasPermission("admin:members");
    const memberEditButton = byId("member-dialog-edit");
    if (memberEditButton) {
      memberEditButton.hidden = !canManageMembers;
      memberEditButton.disabled = !canManageMembers || state.memberEditSaving;
    }
    for (const control of byId("member-edit-form")?.querySelectorAll("input, button") || []) {
      control.disabled = !canManageMembers || state.memberEditSaving;
    }
  }

  async function loadTemporaryKeys(page = state.temporaryKeys.page) {
    if (!canView("access")) return;
    const params = new URLSearchParams({
      page: String(Math.max(1, page)),
      search: state.temporaryKeySearch,
      status: state.temporaryKeyStatus
    });
    try {
      state.temporaryKeys = await request(`/api/admin/temp-keys?${params}`);
      renderTemporaryKeys();
    } catch (error) {
      byId("save-state").textContent = error.message;
    }
  }

  function renderTemporaryKeys() {
    const root = byId("temporary-key-list");
    if (!root) return;
    root.replaceChildren();
    const payload = state.temporaryKeys;
    const items = payload.items || [];
    const pages = Math.max(1, Math.ceil((payload.total || 0) / 10));
    if (!items.length) {
      root.append(create("p", "empty-state", "没有符合条件的临时 Key。"));
    } else {
      for (const item of items) {
        let permissions = [];
        try {
          permissions = JSON.parse(item.permissions_json || "[]");
        } catch {
          permissions = [];
        }
        const availablePermissions = new Set(
          (state.bootstrap?.permissionCatalog || []).map((permission) => permission.key)
        );
        permissions = permissions.filter((permission) =>
          availablePermissions.has(permission)
        );
        const row = create("article", "key-item");
        const identity = create("div");
        identity.append(
          create("strong", "", item.name),
          create(
            "div",
            "key-item-meta",
            window.MrzhI18n.format("编号 {id}", { id: item.id })
          )
        );
        const suffix = [
          permissions
            .map((permission) => window.MrzhI18n.t(permissionName(permission)))
            .join(" · "),
          item.permanent === 1
            ? window.MrzhI18n.t("永久有效")
            : window.MrzhI18n.format("有效期 {date}", {
                date: formatDate(item.expires_at)
              }),
          item.last_used_at
            ? window.MrzhI18n.format("最近使用 {date}", {
                date: formatDate(item.last_used_at)
              })
            : "",
          item.revoked_at ? window.MrzhI18n.t("已撤销") : ""
        ]
          .filter(Boolean)
          .join(" · ");
        const actions = create("div", "key-item-actions");
        const edit = create(
          "button",
          "button button-quiet",
          window.MrzhI18n.t("编辑权限")
        );
        edit.type = "button";
        edit.hidden = !hasPermission("keys:manage");
        edit.disabled = Boolean(item.revoked_at);
        edit.addEventListener("click", () =>
          openTemporaryKeyPermissions(item, permissions)
        );
        const revoked = Boolean(item.revoked_at);
        const keyAction = create(
          "button",
          "button button-danger",
          window.MrzhI18n.t(revoked ? "删除" : "撤销")
        );
        keyAction.type = "button";
        keyAction.hidden = !hasPermission("keys:manage");
        keyAction.addEventListener("click", () =>
          revoked
            ? deleteRevokedTemporaryKey(item.id, keyAction)
            : revokeTemporaryKey(item.id, keyAction)
        );
        actions.append(edit, keyAction);
        row.append(identity, create("div", "key-item-meta", suffix), actions);
        root.append(row);
      }
    }
    setText("temporary-key-page", `${payload.page || 1} / ${pages}`);
    byId("temporary-key-prev").disabled = (payload.page || 1) <= 1;
    byId("temporary-key-next").disabled = (payload.page || 1) >= pages;
    byId("temporary-key-jump").max = String(pages);
    byId("temporary-key-jump").value = String(payload.page || 1);
  }

  function renderAdminMembers(items) {
    const query = state.memberQuery.toLowerCase();
    const filtered = items.filter((item) =>
      [
        item.name,
        item.profession,
        item.roommate_name,
        item.camp_title
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query))
    );
    const root = byId("admin-member-table");
    root.replaceChildren();
    for (const item of filtered) {
      const row = document.createElement("tr");
      row.className = "member-admin-row";
      for (const value of [
        item.name,
        item.identity_code || "—",
        item.profession || "—",
        item.manor_level ?? "—",
        item.roommate_name || "—",
        item.weekly_contribution ?? 0,
        item.technology_points_used ?? 0,
        item.material_contribution ?? 0,
        item.weekly_activity_points ?? 0
      ]) {
        row.append(create("td", "", String(value)));
      }
      row.addEventListener("click", () => showMember(item));
      root.append(row);
    }
  }

  function renderMemberDetail(member) {
    byId("member-dialog-title").textContent = member.name;
    const detail = byId("member-detail");
    detail.replaceChildren();
    for (const [label, value] of [
      ["营地称号", member.camp_title],
      ["身份识别码", member.identity_code],
      ["职业", member.profession],
      ["庄园等级", member.manor_level],
      ["同居", member.roommate_name],
      ["本周贡献", member.weekly_contribution],
      ["使用科技点", member.technology_points_used],
      ["贡献物资", member.material_contribution],
      ["周活跃点", member.weekly_activity_points],
      ["资料采集时间", formatDate(member.last_seen_at)]
    ]) {
      detail.append(create("dt", "", label), create("dd", "", String(value ?? "—")));
    }
  }

  function showMember(member) {
    state.selectedMember = member;
    renderMemberDetail(member);
    setModuleActionState();
    byId("member-dialog").showModal();
  }

  function openMemberEdit() {
    const member = state.selectedMember;
    if (!member || !hasPermission("admin:members")) return;
    byId("member-edit-name").textContent = formatUi("成员名称：{name}（不可编辑）", {
      name: member.name
    });
    for (const [id, value] of [
      ["member-edit-camp-title", member.camp_title],
      ["member-edit-profession", member.profession],
      ["member-edit-manor-level", member.manor_level],
      ["member-edit-roommate-name", member.roommate_name],
      ["member-edit-weekly-contribution", member.weekly_contribution ?? 0],
      ["member-edit-technology-points-used", member.technology_points_used ?? 0],
      ["member-edit-material-contribution", member.material_contribution ?? 0],
      ["member-edit-weekly-activity-points", member.weekly_activity_points ?? 0],
      ["member-edit-capture-time", formatDate(member.last_seen_at)]
    ]) {
      byId(id).value = value ?? "";
    }
    const identitySelect = byId("member-edit-identity-code");
    if (identitySelect) {
      identitySelect.replaceChildren();
      identitySelect.append(create("option", "", "自动匹配（不保存绑定）"));
      for (const option of state.bootstrap?.identityCodeOptions || []) {
        const item = create("option", "", `${option.code} · ${option.playerName || "—"}`);
        item.value = option.id;
        identitySelect.append(item);
      }
      identitySelect.value = member.identity_code_id || "";
    }
    setText("member-edit-feedback", "");
    const dialog = byId("member-edit-dialog");
    if (!dialog.open) dialog.showModal();
    setModuleActionState();
  }

  function closeMemberEdit() {
    const dialog = byId("member-edit-dialog");
    if (dialog?.open && !state.memberEditSaving) dialog.close();
  }

  async function saveMemberEdit(event) {
    event.preventDefault();
    const member = state.selectedMember;
    const form = event.currentTarget;
    if (!member || !hasPermission("admin:members") || !form.reportValidity()) return;
    const optionalText = (name) => {
      const value = String(form.elements[name]?.value || "").trim();
      return value || null;
    };
    const optionalInteger = (name) => {
      const value = String(form.elements[name]?.value || "").trim();
      return value === "" ? null : Number(value);
    };
    const payload = {
      identityCodeId: String(form.elements.identityCodeId?.value || "") || null,
      campTitle: optionalText("campTitle"),
      profession: optionalText("profession"),
      manorLevel: optionalInteger("manorLevel"),
      roommateName: optionalText("roommateName"),
      weeklyContribution: Number(form.elements.weeklyContribution.value),
      technologyPointsUsed: Number(form.elements.technologyPointsUsed.value),
      materialContribution: Number(form.elements.materialContribution.value),
      weeklyActivityPoints: Number(form.elements.weeklyActivityPoints.value)
    };
    state.memberEditSaving = true;
    setText("member-edit-feedback", "正在保存…");
    setModuleActionState();
    try {
      const result = await request(
        `/api/admin/members/${encodeURIComponent(member.id)}`,
        { method: "PUT", body: JSON.stringify(payload) }
      );
      const updated = result.member;
      if (!updated) throw new Error("成员信息保存失败");
      state.bootstrap.members = (state.bootstrap.members || []).map((item) =>
        item.id === updated.id ? updated : item
      );
      state.selectedMember = updated;
      renderAdminMembers(state.bootstrap.members);
      renderMemberDetail(updated);
      byId("member-edit-dialog").close();
      setText("save-state", "成员信息已保存");
    } catch (error) {
      setText("member-edit-feedback", error.message);
    } finally {
      state.memberEditSaving = false;
      setModuleActionState();
    }
  }

  async function refresh(forceAll = false) {
    if (state.refreshing || state.saving) {
      state.liveDirty = true;
      return;
    }
    state.refreshing = true;
    try {
      const data = await request(
        `/api/admin/bootstrap?t=${Date.now()}&locale=${encodeURIComponent(window.MrzhI18n.language())}`
      );
      // The technology editor is a local draft, not a read-only projection of
      // the latest bootstrap response. Preserve its unsaved choices while still
      // applying WebSocket-triggered updates to the other bootstrap sections.
      const preserveTechnologyEditor =
        !forceAll &&
        state.activeView === "technology" &&
        state.technologyDraft !== null;
      const sections = forceAll
        ? CONFIG_SECTIONS
        : CONFIG_SECTIONS.filter(
            (section) =>
              !state.dirtySections.has(section) &&
              !(section === "technology" && preserveTechnologyEditor)
          );
      render(data, sections);
    } catch (error) {
      byId("save-state").textContent = error.message;
    } finally {
      state.refreshing = false;
      flushLiveRefresh();
    }
  }

  function flushLiveRefresh() {
    if (
      !state.liveDirty ||
      document.hidden ||
      state.refreshing ||
      state.saving
    ) return;
    state.liveDirty = false;
    void refresh(false);
  }

  function refreshOpenAdminViews() {
    const preserveIdentityMenu = state.runActionMenu?.trigger?.isConnected &&
      (state.activeView === "identity-applications" || state.activeView === "identity-codes");
    if (preserveIdentityMenu) {
      state.identityListRefreshQueued = true;
    } else if (state.activeView === "identity-applications") {
      void loadIdentityApplications();
    } else if (state.activeView === "identity-codes") {
      void loadIdentityCodes();
    }

    const technologyHistoryCard = document.querySelector(
      '[data-vote-history-card="technology"]'
    );
    if (technologyHistoryCard?.open && state.activeView === "technology-history") {
      state.technologyHistoryLoaded = false;
      void loadTechnologyHistory(byId("technology-history-date")?.value || "");
    }
    const dailyHistoryCard = document.querySelector(
      '[data-vote-history-card="daily-vote"]'
    );
    if (dailyHistoryCard?.open && state.activeView === "technology-history") {
      void loadDailyVoteAdmin(
        byId("daily-vote-history-date")?.value || "",
        state.dailyVoteHistoryPage,
        "history"
      );
    }

    const generalVoteCard = document.querySelector(
      '[data-vote-management-card="general"]'
    );
    if (generalVoteCard?.open && state.activeView === "technology") {
      void loadDailyVoteAdmin("", state.dailyVotePage, "active");
    }
    const dailyVoteCard = document.querySelector(
      '[data-vote-management-card="daily-vote"]'
    );
    if (dailyVoteCard?.open && state.activeView === "technology") {
      void loadDailyVoteAdmin("", 1, "active");
    }
  }

  function scheduleLiveReconnect() {
    if (state.liveReconnectTimer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** state.liveReconnectAttempt);
    state.liveReconnectAttempt = Math.min(state.liveReconnectAttempt + 1, 5);
    state.liveReconnectTimer = window.setTimeout(() => {
      state.liveReconnectTimer = null;
      connectLiveUpdates();
    }, delay);
  }

  function connectLiveUpdates() {
    if (state.liveSocket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(state.liveSocket.readyState)) {
      return;
    }
    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(
      `${scheme}//${window.location.host}/api/live?scope=admin`
    );
    state.liveSocket = socket;
    socket.addEventListener("open", () => {
      if (state.liveSocket !== socket) return;
      state.liveReconnectAttempt = 0;
      socket.send(JSON.stringify({ type: "subscribe", scope: "admin" }));
      void refresh(false);
    });
    socket.addEventListener("message", (event) => {
      if (state.liveSocket !== socket) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (
        message?.type === "data-changed" &&
        Array.isArray(message.scopes) &&
        message.scopes.includes("admin")
      ) {
        if (
          message.reason === "agent-log-stream" &&
          state.activeEventRunId &&
          !document.hidden
        ) {
          void refreshRunEvents(state.activeEventRunId);
        } else if (document.hidden) {
          state.liveDirty = true;
        } else {
          void refresh(false);
          refreshOpenAdminViews();
        }
      }
    });
    socket.addEventListener("close", () => {
      if (state.liveSocket !== socket) return;
      state.liveSocket = null;
      scheduleLiveReconnect();
    });
    socket.addEventListener("error", () => {
      if (state.liveSocket === socket) socket.close();
    });
  }

  async function runTask(taskKey, button, routineId) {
    button.disabled = true;
    try {
      const result = await request("/api/admin/run", {
        method: "POST",
        body: JSON.stringify({
          taskKey,
          locale: window.MrzhI18n.language(),
          ...(routineId ? { routineId } : {})
        })
      });
      byId("save-state").textContent = result.queuedBehindActiveRun
        ? window.MrzhI18n.format(
            "当前 Agent 已有任务正在运行或排队；手工任务已入队，等待上一个任务结束后执行"
          )
        : window.MrzhI18n.format("{task}已入队", {
            task: taskName(taskKey)
          });
      await refresh(false);
    } catch (error) {
      byId("save-state").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  async function interruptRun(runId, button) {
    button.disabled = true;
    try {
      const result = await request("/api/admin/interrupt", {
        method: "POST",
        body: JSON.stringify({ runId })
      });
      byId("save-state").textContent =
        result.state === "interrupted"
          ? "排队任务已终止"
          : "终止指令已发送";
      await refresh(false);
    } catch (error) {
      byId("save-state").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  async function showEvents(runId) {
    stopEventRefresh();
    state.activeEventRunId = runId;
    state.eventSignature = "";
    state.eventEntries = [];
    state.eventLastId = null;
    state.eventLoaded = false;
    state.eventLocaleRevision += 1;
    const root = byId("run-events");
    root.replaceChildren(create("p", "empty-state", "正在加载…"));
    byId("run-dialog").showModal();
    await refreshRunEvents(runId);
  }

  async function refreshRunEvents(runId) {
    if (
      state.activeEventRunId !== runId ||
      state.eventRefreshInFlight
    ) {
      return;
    }
    state.eventRefreshInFlight = true;
    const root = byId("run-events");
    const requestedLocale = window.MrzhI18n.language();
    const localeRevision = state.eventLocaleRevision;
    try {
      const initialLoad = !state.eventLoaded;
      const params = new URLSearchParams({
        limit: "400",
        locale: requestedLocale
      });
      if (initialLoad) params.set("latest", "1");
      else if (state.eventLastId != null) {
        params.set("afterId", String(state.eventLastId));
      }
      const payload = await request(
        `/api/admin/runs/${encodeURIComponent(runId)}/events?${params}`
      );
      const fetched = payload.events || [];
      if (state.activeEventRunId !== runId) return;
      if (
        localeRevision !== state.eventLocaleRevision ||
        requestedLocale !== window.MrzhI18n.language()
      ) {
        // A language switch happened while the previous request was in
        // flight. Discard that response and issue a fresh full-timeline load
        // after the in-flight guard is released.
        window.setTimeout(() => refreshRunEvents(runId), 0);
        return;
      }
      if (initialLoad) {
        state.eventEntries = fetched.slice(-4_000);
      } else if (fetched.length) {
        state.eventEntries = [...state.eventEntries, ...fetched].slice(-4_000);
      }
      state.eventLoaded = true;
      state.eventLastId =
        state.eventEntries.length
          ? Number(state.eventEntries[state.eventEntries.length - 1].id)
          : null;
      const events = state.eventEntries;
      const tail = events.at(-1);
      const signature = `${events.length}:${tail?.id || ""}:${tail?.created_at || ""}:${tail?.message || ""}`;
      if (signature === state.eventSignature) return;
      state.eventSignature = signature;
      if (initialLoad) root.replaceChildren();
      if (!events.length && initialLoad) {
        root.append(create("p", "empty-state", "暂无步骤事件。"));
      }
      const rows = initialLoad ? events : fetched;
      if (!initialLoad && rows.length) {
        root.querySelector(".empty-state")?.remove();
        while (root.children.length >= 4_000) root.firstElementChild?.remove();
      }
      for (const event of rows) {
        const row = create("article", "event-item");
        row.append(
          create("span", `status-${event.level}`, event.level),
          create("time", "muted", formatDate(event.created_at)),
          create("span", "", `${event.step ? `[${event.step}] ` : ""}${event.message}`)
        );
        root.append(row);
      }
      // Events are rendered oldest-first so the run can be read as a timeline,
      // but the useful state is always at the tail. Keep the newest event in
      // view after the initial load and every WebSocket-triggered refresh.
      root.scrollTop = root.scrollHeight;
    } catch (error) {
      if (state.activeEventRunId === runId) {
        root.replaceChildren(create("p", "error-text", error.message));
      }
    } finally {
      state.eventRefreshInFlight = false;
    }
  }

  function stopEventRefresh() {
    state.activeEventRunId = null;
    state.eventSignature = "";
    state.eventEntries = [];
    state.eventLastId = null;
  }

  function collectConfig(section) {
    const next = JSON.parse(
      JSON.stringify(state.bootstrap.configBundle)
    );
    if (section === "general") {
      capturePublicContentDraft();
      const timezone = String(getField("timezone")).trim();
      next.campConfig = {
        ...next.campConfig,
        campName: String(getField("campName")).trim(),
        serverName: String(getField("serverName")).trim(),
        publicSiteName: String(getField("publicSiteName")).trim(),
        timezone,
        gameResetTime: getField("gameResetTime"),
        specialDailyRefreshTime: getField("specialDailyRefreshTime"),
        publicMembersEnabled: getField("publicMembersEnabled"),
        inactivityWarningDays: Number(getField("inactivityWarningDays"))
      };
      next.authConfig = {
        temporaryKeyLoginEnabled: getField("temporaryKeyLoginEnabled")
      };
      next.publicOverview = {
        announcement: state.publicContentDraft["zh-cn"].announcement,
        highlights: state.publicContentDraft["zh-cn"].highlights,
        localized: state.publicContentDraft
      };
      next.automationConfig.timezone = timezone;
    } else if (section === "tasks") {
      const timesFor = (taskKey, fieldName) => {
        const values = scheduleTimes(taskKey).filter(Boolean);
        return values.length ? values : [String(getField(fieldName) || "")];
      };
      const techTimes = timesFor("tech_switch", "techTime");
      const contributionTimes = timesFor("contribution_sync", "contributionTime");
      const inactivityTimes = timesFor("inactivity_sync", "inactivityTime");
      const profileTimes = timesFor("member_profile_sync", "profileTime");
      const patrolTime = String(getField("patrolTime") || "");
      next.automationConfig.scheduledRetryCount = Number(getField("scheduledRetryCount"));
      next.automationConfig.manualRetryCount = Number(getField("manualRetryCount"));
      next.automationConfig.tasks = {
        tech_switch: {
          enabled: getField("techEnabled"),
          time: techTimes[0],
          times: techTimes,
          weekdays: scheduleWeekdays("tech_switch"),
          replaceTimes: Boolean(state.scheduleReplacements.tech_switch)
        },
        contribution_sync: {
          enabled: getField("contributionEnabled"),
          time: contributionTimes[0],
          times: contributionTimes,
          weekdays: scheduleWeekdays("contribution_sync"),
          replaceTimes: Boolean(state.scheduleReplacements.contribution_sync)
        },
        inactivity_sync: {
          enabled: getField("inactivityEnabled"),
          time: inactivityTimes[0],
          times: inactivityTimes,
          weekdays: scheduleWeekdays("inactivity_sync"),
          replaceTimes: Boolean(state.scheduleReplacements.inactivity_sync)
        },
        member_profile_sync: {
          enabled: getField("profileEnabled"),
          time: profileTimes[0],
          times: profileTimes,
          weekdays: scheduleWeekdays("member_profile_sync"),
          replaceTimes: Boolean(state.scheduleReplacements.member_profile_sync)
        },
        weekly_activity_sync: {
          enabled: getField("weeklyActivityEnabled"),
          time: scheduleTimes("weekly_activity_sync")[0],
          times: scheduleTimes("weekly_activity_sync"),
          weekdays: scheduleWeekdays("weekly_activity_sync"),
          replaceTimes: Boolean(state.scheduleReplacements.weekly_activity_sync)
        },
        patrol: {
          enabled: getField("patrolEnabled"),
          time: patrolTime,
          times: [patrolTime],
          weekdays: scheduleWeekdays("patrol"),
          replaceTimes: Boolean(state.scheduleReplacements.patrol),
          teamReadyTime: getField("patrolReadyTime"),
          shareIntervalMinutes: Number(getField("shareInterval")),
          chatPollSeconds: Number(getField("chatPollSeconds")),
          deadline: getField("patrolDeadline")
        }
      };
    } else if (section === "agent") {
      let pollingWindows;
      try {
        pollingWindows = JSON.parse(byId("polling-windows-json").value);
      } catch {
        throw new Error("轮询窗口 JSON 格式错误");
      }
      next.automationConfig.agentPolling = {
        activeSeconds: Number(getField("pollActiveSeconds")),
        scheduledWindowMinutes: Number(getField("pollScheduledWindowMinutes")),
        idleSeconds: Number(getField("pollIdleSeconds")),
        claimTimeoutMinutes: Number(getField("queueClaimTimeoutMinutes")),
        windows: pollingWindows
      };
      next.automationConfig.gameWatchdog = {
        enabled: getField("watchdogEnabled"),
        healthCheckSeconds: Number(getField("watchdogHealthSeconds")),
        actionTimeoutSeconds: Number(getField("watchdogActionSeconds")),
        frozenScreenSeconds: Number(getField("watchdogFrozenSeconds")),
        maxRestarts: Number(getField("watchdogMaxRestarts")),
        restartCooldownSeconds: Number(getField("watchdogCooldownSeconds"))
      };
      next.automationConfig.routines = [];
    } else if (section === "technology") {
      const rawVoteLimit = byId("technology-vote-limit")?.value;
      const voteLimit = rawVoteLimit === "" ? 6 : Number(rawVoteLimit);
      state.technologyDraft.voteLimit = voteLimit;
      const readRowLimit = (id) => {
        const value = Number(byId(id)?.value);
        return Number.isInteger(value) && value >= 0 && value <= 6 ? value : 6;
      };
      state.technologyDraft.limits = {
        core: readRowLimit("technology-core-limit"),
        general: readRowLimit("technology-general-limit")
      };
      state.technologyDraft.voteEligibilityEnabled =
        byId("technology-vote-eligibility-enabled")?.checked !== false;
      const emptyPreset = state.technologyDraft.fixedPresets.find(
        (preset) => !preset.technologyKeys?.length
      );
      if (emptyPreset) {
        throw new Error("每条固定规则至少选择 1 项科技，或删除空规则后再保存");
      }
      // The preset list is the canonical source. Clear legacy maps so deleting
      // a migrated rule cannot leave an invisible weekday/date override behind.
      state.technologyDraft.fixedByDate = {};
      state.technologyDraft.fixedByWeekday = {
        "1": [],
        "2": [],
        "3": [],
        "4": [],
        "5": [],
        "6": [],
        "7": []
      };
      next.technologyConfig = JSON.parse(
        JSON.stringify(state.technologyDraft)
      );
      next.campConfig = {
        ...next.campConfig,
        voteWindowStart: String(getField("voteWindowStart")).trim(),
        voteWindowEnd:
          input("voteWindowEnd")?.dataset.legacyValue === "24:00"
            ? "24:00"
            : String(getField("voteWindowEnd")).trim(),
        currentCampType: getField("currentCampType")
      };
    } else {
      throw new Error("未知配置分区");
    }
    return next;
  }

  function publicHighlightBlocks(item) {
    if (typeof item === "string") {
      const text = item.trim();
      return text ? [{ type: "text", text }] : [];
    }
    if (!item || typeof item !== "object" || !Array.isArray(item.blocks)) {
      return [];
    }
    return item.blocks.filter(
      (block) =>
        block &&
        typeof block === "object" &&
        (block.type === "text" || block.type === "image")
    );
  }

  function serializePublicHighlights(items) {
    return (items || [])
      .map((item) =>
        publicHighlightBlocks(item)
          .map((block) =>
            block.type === "image"
              ? block.alt
                ? `![${block.alt}](${block.url})`
                : `![](${block.url})`
              : String(block.text || "")
          )
          .filter(Boolean)
          .join("\n")
      )
      .filter(Boolean)
      .join("\n\n");
  }

  function parsePublicImageLine(line) {
    const source = String(line || "");
    const markdown = String(line || "").match(
      /^\s*!\[([^\]]*)\]\((https:\/\/[^)\s]+)\)\s*$/i
    );
    return markdown
      ? {
          type: "image",
          url: markdown[2],
          ...(markdown[1].trim() ? { alt: markdown[1].trim() } : {})
        }
      : null;
  }

  function parsePublicHighlights(value) {
    return String(value || "")
      .split(/\n\s*\n/)
      .map((entry) => {
        const blocks = [];
        let textLines = [];
        const flushText = () => {
          const text = textLines.join("\n").trim();
          if (text) blocks.push({ type: "text", text });
          textLines = [];
        };
        for (const line of entry.split("\n")) {
          const image = parsePublicImageLine(line);
          if (image) {
            flushText();
            blocks.push(image);
          } else {
            textLines.push(line);
          }
        }
        flushText();
        return { blocks };
      })
      .filter((item) => item.blocks.length);
  }

  function capturePublicContentDraft() {
    if (!state.publicContentDraft) return;
    state.publicContentDraft[state.publicContentLocale] = {
      announcement: String(getField("announcement") || "").trim(),
      highlights: parsePublicHighlights(getField("highlights"))
    };
  }

  function switchPublicContentLocale(locale) {
    capturePublicContentDraft();
    state.publicContentLocale = locale;
    const content = state.publicContentDraft?.[locale] || {
      announcement: "",
      highlights: []
    };
    setField("announcement", content.announcement);
    setField("highlights", serializePublicHighlights(content.highlights));
  }

  async function saveConfig(event) {
    event.preventDefault();
    if (state.saving) return;
    const form = event.currentTarget;
    const section = form.dataset.configSection;
    const feedback = form.querySelector("[data-save-feedback]");
    const buttons = [
      ...document.querySelectorAll('.config-form button[type="submit"]')
    ];
    state.saving = true;
    feedback.textContent = "正在保存…";
    byId("save-state").textContent = "正在保存…";
    for (const button of buttons) button.disabled = true;
    try {
      const data = await request("/api/admin/config", {
        method: "PUT",
        headers: { "X-Admin-Section": section },
        body: JSON.stringify(collectConfig(section))
      });
      state.dirtySections.delete(section);
      render(data, [section]);
      feedback.textContent = "配置已保存";
      updateSaveState("配置已保存");
    } catch (error) {
      feedback.textContent = error.message;
      byId("save-state").textContent = error.message;
    } finally {
      state.saving = false;
      setConfigReadOnly();
      flushLiveRefresh();
    }
  }

  async function logout() {
    sessionStorage.setItem("yumePublicOidcAutoLoginSuppressed", "1");
    location.href = "/auth/logout";
  }

  async function generateTemporaryKey(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const permissions = [
      ...form.querySelectorAll('[name="keyPermission"]:checked')
    ].map((field) => field.value);
    if (!permissions.length) {
      byId("save-state").textContent = window.MrzhI18n.t(
        "请输入至少一项权限；仅预览请勾选 Demo 权限"
      );
      return;
    }
    const permanent = form.elements.keyPermanent.checked;
    try {
      const payload = await request("/api/admin/temp-keys", {
        method: "POST",
        body: JSON.stringify({
          name: form.elements.keyName.value.trim(),
          expiresLocal: permanent ? null : form.elements.keyExpiresAt.value,
          permanent,
          permissions
        })
      });
      byId("temporary-key-value").textContent = payload.key;
      byId("temporary-key-reveal").hidden = false;
      form.reset();
      form.elements.keyExpiresAt.disabled = false;
      form.elements.keyExpiresAt.required = true;
      setDefaultKeyExpiry();
      await loadTemporaryKeys(1);
    } catch (error) {
      byId("save-state").textContent = error.message;
    }
  }

  async function revokeTemporaryKey(id, button) {
    button.disabled = true;
    try {
      await request("/api/admin/temp-keys/revoke", {
        method: "POST",
        body: JSON.stringify({ id })
      });
      await loadTemporaryKeys();
    } catch (error) {
      byId("save-state").textContent = error.message;
      button.disabled = false;
    }
  }

  async function deleteRevokedTemporaryKey(id, button) {
    const label = window.MrzhI18n.t("临时 Key");
    if (!(await showAppConfirm(
      window.MrzhI18n.format("确认删除{label}吗？删除后无法从后台恢复。", { label }),
      { title: "删除", danger: true }
    ))) return;
    button.disabled = true;
    try {
      await request(`/api/admin/temp-keys/${encodeURIComponent(id)}`, {
        method: "DELETE"
      });
      await loadTemporaryKeys();
    } catch (error) {
      byId("save-state").textContent = error.message;
      button.disabled = false;
    }
  }

  function openTemporaryKeyPermissions(item, permissions) {
    state.editingTemporaryKeyId = item.id;
    byId("temporary-key-permissions-title").textContent =
      window.MrzhI18n.format("编辑权限 · {name}", { name: item.name });
    byId("temporary-key-permissions-feedback").textContent = "";
    const selected = new Set(permissions);
    for (const field of document.querySelectorAll('[name="keyEditPermission"]')) {
      field.checked = selected.has(field.value);
    }
    byId("temporary-key-permissions-dialog").showModal();
  }

  async function saveTemporaryKeyPermissions(event) {
    event.preventDefault();
    const id = state.editingTemporaryKeyId;
    if (!id) return;
    const form = event.currentTarget;
    const permissions = [
      ...form.querySelectorAll('[name="keyEditPermission"]:checked')
    ].map((field) => field.value);
    if (!permissions.length) {
      byId("temporary-key-permissions-feedback").textContent = window.MrzhI18n.t(
        "请选择至少一项权限"
      );
      return;
    }
    const save = byId("temporary-key-permissions-save");
    save.disabled = true;
    try {
      await request(`/api/admin/temp-keys/${encodeURIComponent(id)}/permissions`, {
        method: "PATCH",
        body: JSON.stringify({ permissions })
      });
      byId("temporary-key-permissions-feedback").textContent =
        window.MrzhI18n.t("权限已更新；该 Key 的现有登录会话已失效。");
      await loadTemporaryKeys();
      window.setTimeout(() => byId("temporary-key-permissions-dialog").close(), 500);
    } catch (error) {
      byId("temporary-key-permissions-feedback").textContent = error.message;
    } finally {
      save.disabled = false;
    }
  }

  function setDefaultKeyExpiry() {
    const field = input("keyExpiresAt");
    if (!field || field.value) return;
    const date = new Date(Date.now() + 24 * 60 * 60_000);
    const parts = zonedInputParts(date);
    field.value =
      `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  }

  function identityExpiryDate(value) {
    const date = value
      ? new Date(value)
      : new Date(Date.now() + 30 * 24 * 60 * 60_000);
    const parts = zonedInputParts(date);
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  async function loadIdentityApplications(page = state.identityApplications.page) {
    if (!canView("identity-applications")) return;
    const params = new URLSearchParams({
      page: String(Math.max(1, page)),
      search: state.identityApplicationSearch,
      status: state.identityApplicationStatus
    });
    try {
      state.identityApplications = await request(
        `/api/admin/identity-applications?${params}`
      );
      renderIdentityApplications();
    } catch (error) {
      byId("save-state").textContent = error.message;
    }
  }

  function renderIdentityApplications() {
    const payload = state.identityApplications;
    const pages = Math.max(1, Math.ceil(payload.total / 10));
    const root = byId("identity-application-table");
    const activeTrigger = state.runActionMenu?.trigger;
    const replacingActiveTrigger = Boolean(activeTrigger && root.contains(activeTrigger));
    root.replaceChildren();
    if (replacingActiveTrigger) closeRunActionMenu();
    for (const item of payload.items) {
      const row = document.createElement("tr");
      for (const value of [
        item.application_number,
        item.record_type === "profile_change"
          ? "资料变更"
          : item.record_type === "eligibility_override"
            ? window.MrzhI18n.t("投票资格")
          : item.request_type === "renewal"
            ? "延期"
            : item.request_type === "reissue"
              ? "重新发行"
              : "新申请",
        item.player_name,
        item.email,
        item.locale,
        item.status === "pending"
          ? "待审批"
          : item.status === "approved"
            ? "已通过"
            : "已拒绝",
        formatDate(item.submitted_at)
      ]) {
        row.append(create("td", "", value));
      }
      const actionCell = create("td", "run-actions");
      const operation = createRunActionButton(
        "操作",
        "button-quiet run-action-trigger",
        "operation"
      );
      operation.setAttribute("aria-haspopup", "menu");
      operation.setAttribute("aria-expanded", "false");
      operation.disabled = !hasPermission("identity:review");
      operation.addEventListener("click", (event) => {
        event.stopPropagation();
        const menuItems = [];
        if (item.status === "pending") {
          menuItems.push({
            label: "审批",
            icon: "events",
            onSelect: () => openIdentityReview(item)
          });
        }
        menuItems.push({
          label: "删除记录",
          icon: "stop",
          danger: true,
          onSelect: () => deleteIdentityApplicationRecord(item)
        });
        toggleActionMenu(operation, menuItems);
      });
      actionCell.append(operation);
      row.append(actionCell);
      root.append(row);
    }
    if (!payload.items.length) {
      const row = document.createElement("tr");
      const cell = create("td", "empty-state", "没有符合条件的申请。");
      cell.colSpan = 8;
      row.append(cell);
      root.append(row);
    }
    setText("identity-app-page", `${payload.page} / ${pages}`);
    byId("identity-app-prev").disabled = payload.page <= 1;
    byId("identity-app-next").disabled = payload.page >= pages;
    byId("identity-app-jump").max = String(pages);
    byId("identity-app-jump").value = String(payload.page);
  }

  function setText(id, value) {
    const element = byId(id);
    if (element) element.textContent = value ?? "";
  }

  function openIdentityReview(item) {
    state.selectedIdentityApplication = item;
    const isProfileChange = item.record_type === "profile_change";
    const isEligibilityApplication = item.record_type === "eligibility_override";
    setText(
      "identity-review-title",
      isProfileChange
        ? "审批资料变更"
        : isEligibilityApplication
          ? window.MrzhI18n.t("审批投票资格申请")
        : item.request_type === "renewal"
          ? "审批延期申请"
          : item.request_type === "reissue"
            ? "审批重新发行申请"
            : "审批身份识别码"
    );
    const detail = byId("identity-review-detail");
    detail.replaceChildren();
    const eligibilityApprovalSetting = isEligibilityApplication
      ? item.approved_votes !== null && item.approved_votes !== undefined
        ? `${window.MrzhI18n.t("允许破格投票次数")}: ${item.approved_votes}`
        : item.approved_expires_at
          ? `${window.MrzhI18n.t("破格投票有效期至")}: ${formatIdentityExpiry(item.approved_expires_at)}`
          : "—"
      : "—";
    const detailRows = isProfileChange
      ? [
          ["申请编号", item.application_number || "—"],
          ["资料类型", item.profile_kind === "email" ? "绑定/修改邮箱" : "修改玩家名称"],
          [
            "当前资料",
            item.profile_kind === "email"
              ? item.current_email || "—"
              : item.current_player_name || "—"
          ],
          [
            "申请变更为",
            item.profile_kind === "email"
              ? item.requested_email || "—"
              : item.requested_player_name || "—"
          ],
          ["提交时间", formatDate(item.submitted_at)]
        ]
      : isEligibilityApplication
        ? [
          [window.MrzhI18n.t("申请编号"), item.application_number || "—"],
          [window.MrzhI18n.t("玩家名称"), item.player_name || "—"],
          [window.MrzhI18n.t("接收邮箱"), item.email || "—"],
          [window.MrzhI18n.t("申请理由"), item.eligibility_reason || "—"],
          [window.MrzhI18n.t("本周贡献"), String(item.eligibility_weekly_contribution ?? 0)],
          [window.MrzhI18n.t("科技点"), String(item.eligibility_technology_points ?? 0)],
          [window.MrzhI18n.t("物资"), String(item.eligibility_material_contribution ?? 0)],
          [window.MrzhI18n.t("周活跃点"), String(item.eligibility_weekly_activity_points ?? 0)],
          [window.MrzhI18n.t("提交时间"), formatDate(item.submitted_at)],
          ...(item.reviewed_at
            ? [[window.MrzhI18n.t("审批时间"), formatDate(item.reviewed_at)]]
            : []),
          ...(item.status === "approved"
            ? [[window.MrzhI18n.t("批准设置"), eligibilityApprovalSetting]]
            : [])
        ]
        : [
          ["申请编号", item.application_number],
          ["玩家名称", item.player_name],
          ["接收邮箱", item.email],
          ["邮件语言", item.locale],
          [
            "申请类型",
            item.request_type === "renewal"
              ? "延期"
              : item.request_type === "reissue"
                ? "重新发行"
                : "新申请"
          ]
        ];
    for (const [label, value] of detailRows) {
      detail.append(create("dt", "", label), create("dd", "", value));
    }
    byId("identity-approval-expiry").hidden = isProfileChange || isEligibilityApplication;
    byId("identity-eligibility-approval-fields").hidden = !isEligibilityApplication;
    byId("identity-eligibility-no-mode-label").hidden = true;
    byId("identity-eligibility-bypass-field").hidden = !isEligibilityApplication;
    byId("identity-eligibility-prohibition-field").hidden = !isEligibilityApplication;
    byId("identity-eligibility-edit-save").hidden = true;
    byId("identity-review-approve").hidden = false;
    byId("identity-review-reject").hidden = false;
    setText("identity-eligibility-votes-mode-label", window.MrzhI18n.t("按次数批准"));
    setText("identity-eligibility-date-mode-label", window.MrzhI18n.t("按日期批准"));
    setText("identity-eligibility-approved-votes-label", window.MrzhI18n.t("允许破格投票次数"));
    setText(
      "identity-review-approve",
      isProfileChange ? "批准并应用并发送邮件" : "通过并发送邮件"
    );
    setText(
      "identity-review-reject",
      isProfileChange ? "拒绝并发送通知" : "拒绝并发送通知"
    );
    byId("identity-review-expiry").value = identityExpiryDate();
    byId("identity-review-permanent").checked = false;
    byId("identity-eligibility-votes-mode").checked = true;
    byId("identity-eligibility-date-mode").checked = false;
    byId("identity-eligibility-no-mode").checked = false;
    byId("identity-eligibility-bypass").checked = false;
    byId("identity-eligibility-prohibit-voting").checked = false;
    byId("identity-eligibility-approved-votes").value = "1";
    byId("identity-eligibility-approved-votes").disabled = false;
    byId("identity-eligibility-approved-until").value = identityExpiryDate();
    byId("identity-eligibility-approved-until").disabled = true;
    setText("identity-review-feedback", "");
    byId("identity-review-dialog").showModal();
  }

  function openIdentityVoteEligibilityEditor(item) {
    state.selectedIdentityCode = item;
    state.selectedIdentityApplication = null;
    setText("identity-review-title", window.MrzhI18n.t("修改投票资格"));
    const detail = byId("identity-review-detail");
    detail.replaceChildren();
    const currentRows = [
      [window.MrzhI18n.t("身份识别码"), item.code],
      [window.MrzhI18n.t("玩家名称"), item.player_name || "—"],
      [window.MrzhI18n.t("本周贡献"), String(item.eligibility_weekly_contribution ?? 0)],
      [window.MrzhI18n.t("科技点"), String(item.eligibility_technology_points ?? 0)],
      [window.MrzhI18n.t("物资"), String(item.eligibility_material_contribution ?? 0)],
      [window.MrzhI18n.t("周活跃点"), String(item.eligibility_weekly_activity_points ?? 0)],
      [
        window.MrzhI18n.t("当前破格资格"),
        item.eligibility_override_votes !== null && item.eligibility_override_votes !== undefined
          ? window.MrzhI18n.format("剩余 {count} 次", { count: item.eligibility_override_votes })
          : item.eligibility_override_expires_at
            ? window.MrzhI18n.format("有效至 {date}", {
                date: formatIdentityExpiry(item.eligibility_override_expires_at)
              })
            : window.MrzhI18n.t("无")
      ],
      [window.MrzhI18n.t("投票资格豁免"), item.vote_eligibility_bypass === 1
        ? window.MrzhI18n.t("已开启")
        : window.MrzhI18n.t("未开启")],
      [window.MrzhI18n.t("投票权限"), item.vote_permission_disabled === 1
        ? window.MrzhI18n.t("该身份识别码已被管理员禁止投票。")
        : window.MrzhI18n.t("正常")]
    ];
    for (const [label, value] of currentRows) {
      detail.append(create("dt", "", label), create("dd", "", value));
    }

    byId("identity-approval-expiry").hidden = true;
    byId("identity-eligibility-approval-fields").hidden = false;
    byId("identity-eligibility-no-mode-label").hidden = false;
    byId("identity-eligibility-bypass-field").hidden = false;
    byId("identity-eligibility-prohibition-field").hidden = false;
    byId("identity-eligibility-edit-save").hidden = false;
    byId("identity-review-approve").hidden = true;
    byId("identity-review-reject").hidden = true;
    setText("identity-eligibility-votes-mode-label", window.MrzhI18n.t("按剩余次数设置"));
    setText("identity-eligibility-date-mode-label", window.MrzhI18n.t("按有效期设置"));
    setText("identity-eligibility-approved-votes-label", window.MrzhI18n.t("剩余破格投票次数"));
    const mode = item.eligibility_override_votes !== null && item.eligibility_override_votes !== undefined
      ? "votes"
      : item.eligibility_override_expires_at
        ? "date"
        : "none";
    byId("identity-eligibility-votes-mode").checked = mode === "votes";
    byId("identity-eligibility-date-mode").checked = mode === "date";
    byId("identity-eligibility-no-mode").checked = mode === "none";
    byId("identity-eligibility-approved-votes").value = String(
      item.eligibility_override_votes ?? 1
    );
    byId("identity-eligibility-approved-until").value = item.eligibility_override_expires_at
      ? identityExpiryDate(item.eligibility_override_expires_at)
      : identityExpiryDate();
    byId("identity-eligibility-prohibit-voting").checked = item.vote_permission_disabled === 1;
    byId("identity-eligibility-bypass").checked = item.vote_eligibility_bypass === 1;
    byId("identity-eligibility-approved-votes").disabled = mode !== "votes";
    byId("identity-eligibility-approved-until").disabled = mode !== "date";
    setText("identity-review-feedback", "");
    byId("identity-review-dialog").showModal();
  }

  async function saveIdentityVoteEligibility() {
    const item = state.selectedIdentityCode;
    if (!item) return;
    const mode = document.querySelector('[name="eligibilityApprovalMode"]:checked')?.value;
    const button = byId("identity-eligibility-edit-save");
    const feedback = byId("identity-review-feedback");
    button.disabled = true;
    feedback.textContent = window.MrzhI18n.t("正在保存…");
    try {
      await request(`/api/admin/identity-codes/${encodeURIComponent(item.id)}/vote-eligibility`, {
        method: "PATCH",
        body: JSON.stringify({
          eligibilityMode: mode,
          eligibilityVotes: byId("identity-eligibility-approved-votes").value,
          eligibilityExpiresOn: byId("identity-eligibility-approved-until").value,
          prohibitVoting: byId("identity-eligibility-prohibit-voting").checked,
          bypassVoteEligibility: byId("identity-eligibility-bypass").checked
        })
      });
      byId("identity-review-dialog").close();
      byId("save-state").textContent = window.MrzhI18n.t("投票资格已更新");
      await loadIdentityCodes();
    } catch (error) {
      feedback.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  async function deleteIdentityApplicationRecord(item) {
    const label = item.application_number || item.player_name || "该审批记录";
    if (!(await showAppConfirm(
      window.MrzhI18n.format("确认永久删除审批记录「{label}」？此操作无法撤销，且不会删除身份识别码。", { label }),
      { title: "删除审批记录", danger: true }
    ))) return;
    const endpoint = item.record_type === "profile_change"
      ? `/api/admin/identity-profile-change-requests/${encodeURIComponent(item.id)}`
      : `/api/admin/identity-applications/${encodeURIComponent(item.id)}`;
    try {
      await request(endpoint, {
        method: "DELETE",
        body: item.record_type === "profile_change"
          ? undefined
          : JSON.stringify({ recordType: item.record_type || "application" })
      });
      byId("save-state").textContent = window.MrzhI18n.t("审批记录已删除");
      await loadIdentityApplications();
      if (canView("identity-codes")) await loadIdentityCodes();
    } catch (error) {
      byId("save-state").textContent = error.message;
    }
  }

  async function reviewIdentity(action) {
    const item = state.selectedIdentityApplication;
    if (!item) return;
    const isProfileChange = item.record_type === "profile_change";
    const isEligibilityApplication = item.record_type === "eligibility_override";
    const feedback = byId("identity-review-feedback");
    let body;
    if (action === "approve") {
      body = isProfileChange
        ? {}
        : isEligibilityApplication
          ? {
              recordType: "eligibility_override",
              eligibilityMode: document.querySelector('[name="eligibilityApprovalMode"]:checked')?.value,
              eligibilityVotes: byId("identity-eligibility-votes-mode").checked
                ? Number(byId("identity-eligibility-approved-votes").value)
                : null,
              eligibilityExpiresOn: byId("identity-eligibility-date-mode").checked
                ? byId("identity-eligibility-approved-until").value
                : null,
              prohibitVoting: byId("identity-eligibility-prohibit-voting").checked,
              bypassVoteEligibility: byId("identity-eligibility-bypass").checked
            }
        : {
            permanent: byId("identity-review-permanent").checked,
            expiresOn: byId("identity-review-permanent").checked
              ? null
              : byId("identity-review-expiry").value
          };
    } else {
      const reason = await showAppPrompt(
        window.MrzhI18n.t(
          "请填写拒绝理由，该理由将写入用户收到的拒绝通知邮件。"
        ),
        {
          title: "拒绝申请",
          inputLabel: "拒绝理由（必填）",
          inputPlaceholder: "请输入拒绝理由",
          maxLength: 500,
          multiline: true,
          confirmLabel: "确认拒绝",
          cancelLabel: "取消",
          danger: true
        }
      );
      if (reason === null) return;
      if (!reason) {
        feedback.textContent = window.MrzhI18n.t("请填写拒绝理由");
        return;
      }
      body = isEligibilityApplication
        ? { reason, recordType: "eligibility_override" }
        : { reason };
    }
    feedback.textContent = "正在处理并发送邮件…";
    try {
      const endpoint = isProfileChange
        ? "/api/admin/identity-profile-change-requests"
        : "/api/admin/identity-applications";
      const result = await request(
        `${endpoint}/${encodeURIComponent(item.id)}/${action}`,
        { method: "POST", body: JSON.stringify(body) }
      );
      byId("identity-review-dialog").close();
      if (isProfileChange) {
        byId("save-state").textContent =
          result.emailSent
            ? action === "approve"
              ? "资料变更已批准并应用，邮件已发送"
              : "资料变更已拒绝，通知邮件已发送"
            : `资料变更已处理，但邮件发送失败：${result.emailError}`;
      } else {
        byId("save-state").textContent =
          result.emailSent
            ? action === "approve"
              ? "申请已通过并发送邮件"
              : "申请已拒绝并发送通知"
            : `申请已处理，但邮件发送失败：${result.emailError}`;
      }
      await loadIdentityApplications(1);
      if (canView("identity-codes")) await loadIdentityCodes();
    } catch (error) {
      feedback.textContent = error.message;
    }
  }

  async function loadIdentityCodes(page = state.identityCodes.page) {
    if (!canView("identity-codes")) return;
    const params = new URLSearchParams({
      page: String(Math.max(1, page)),
      search: state.identityCodeSearch,
      status: state.identityCodeStatus
    });
    try {
      state.identityCodes = await request(`/api/admin/identity-codes?${params}`);
      renderIdentityCodes();
    } catch (error) {
      byId("save-state").textContent = error.message;
    }
  }

  function openIdentityPasswordReset(item) {
    state.selectedIdentityPasswordResetCode = item;
    setText(
      "identity-password-reset-detail",
      `将为 ${item.player_name || "未命名玩家"}（${item.code}）生成新密码，并发送到 ${item.email || "预留邮箱"}。`
    );
    setText("identity-password-reset-feedback", "");
    byId("identity-password-reset-dialog").showModal();
  }

  async function confirmIdentityPasswordReset() {
    const item = state.selectedIdentityPasswordResetCode;
    if (!item) return;
    if (!(await showAppConfirm(
      "密码重置后旧密码会立即失效，确认继续并发送新密码邮件？",
      { title: "二次确认密码重置", danger: true }
    ))) return;
    const button = byId("identity-password-reset-confirm");
    const feedback = byId("identity-password-reset-feedback");
    button.disabled = true;
    feedback.textContent = window.MrzhI18n.t("正在重置并发送邮件…");
    try {
      await request(
        `/api/admin/identity-codes/${encodeURIComponent(item.id)}/reset-password`,
        { method: "POST" }
      );
      byId("identity-password-reset-dialog").close();
      byId("save-state").textContent = window.MrzhI18n.t("新密码已生成并发送到预留邮箱");
      await loadIdentityCodes();
    } catch (error) {
      feedback.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  function renderIdentityCodes() {
    const payload = state.identityCodes;
    const pages = Math.max(1, Math.ceil(payload.total / 10));
    const root = byId("identity-code-table");
    const activeTrigger = state.runActionMenu?.trigger;
    const replacingActiveTrigger = Boolean(activeTrigger && root.contains(activeTrigger));
    root.replaceChildren();
    if (replacingActiveTrigger) closeRunActionMenu();
    for (const item of payload.items) {
      const row = document.createElement("tr");
      const expired =
        item.status === "active" &&
        item.expires_at &&
        Date.parse(item.expires_at) <= Date.now();
      for (const value of [
        item.application_number || "—",
        item.code,
        item.player_name || "—",
        item.email || "—",
        item.status === "disabled" ? "取消" : expired ? "已过期" : "有效",
        item.expires_at ? formatDateOnly(item.expires_at) : "永久有效",
        item.last_emailed_at ? formatDate(item.last_emailed_at) : "—"
      ]) {
        row.append(create("td", "", value));
      }
      const actions = create("td", "run-actions");
      const operation = createRunActionButton(
        "操作",
        "button-quiet run-action-trigger",
        "operation"
      );
      operation.setAttribute("aria-haspopup", "menu");
      operation.setAttribute("aria-expanded", "false");
      operation.disabled = !hasPermission("identity:manage");
      operation.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleActionMenu(operation, [
          {
            label: item.status === "active" ? "取消识别码" : "恢复",
            icon: item.status === "active" ? "stop" : "events",
            danger: item.status === "active",
            onSelect: () =>
              updateIdentityCodeItem(item, {
                status: item.status === "active" ? "disabled" : "active",
                permanent: !item.expires_at,
                expiresOn: item.expires_at
                  ? identityExpiryDate(item.expires_at)
                  : null
              })
          },
          {
            label: "修改信息",
            icon: "events",
            onSelect: () => editIdentityInformation(item)
          },
          {
            label: "修改投票资格",
            icon: "events",
            onSelect: () => openIdentityVoteEligibilityEditor(item)
          },
          {
            label: "更换识别码",
            icon: "events",
            disabled: !item.email || !item.player_name,
            onSelect: () => reissueIdentity(item)
          },
          {
            label: "重新发送识别码信息邮件",
            icon: "events",
            disabled: !item.email || !item.player_name,
            onSelect: (button) => resendIdentity(item.id, button)
          },
          {
            label: "重置识别码密码",
            icon: "events",
            disabled: !item.email,
            onSelect: () => openIdentityPasswordReset(item)
          },
          {
            label: "删除记录",
            icon: "stop",
            danger: true,
            onSelect: () => deleteIdentityCodeItem(item)
          }
        ]);
      });
      actions.append(operation);
      row.append(actions);
      root.append(row);
    }
    setText("identity-code-page", `${payload.page} / ${pages}`);
    byId("identity-code-prev").disabled = payload.page <= 1;
    byId("identity-code-next").disabled = payload.page >= pages;
    byId("identity-code-jump").max = String(pages);
    byId("identity-code-jump").value = String(payload.page);
  }

  async function updateIdentityCodeItem(item, values) {
    try {
      const result = await request(`/api/admin/identity-codes/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        body: JSON.stringify(values)
      });
      if (values.status === "disabled") {
        byId("save-state").textContent = result.emailSent
          ? "识别码已取消，确认邮件已发送"
          : result.emailError
            ? `识别码已取消，但确认邮件发送失败：${result.emailError}`
            : "识别码已取消";
      }
      await loadIdentityCodes();
    } catch (error) {
      byId("save-state").textContent = error.message;
    }
  }

  async function deleteIdentityCodeItem(item) {
    const label = item.player_name || item.code || "该身份识别码";
    const confirmed = await showAppConfirm(
      window.MrzhI18n.format(
        "确认永久删除「{label}」的身份识别码记录？此操作会同时删除该码的全部日常投票/抽签与科技投票历史，并删除关联的破格资格申请、资料变更申请及验证记录；成员档案中的绑定会解除。身份识别码申请审批记录会保留。此操作无法恢复。",
        { label }
      ),
      { title: "删除身份识别码记录", danger: true }
    );
    if (!confirmed) return;
    try {
      await request(`/api/admin/identity-codes/${encodeURIComponent(item.id)}`, {
        method: "DELETE"
      });
      byId("save-state").textContent = window.MrzhI18n.t("身份识别码记录及其投票历史已删除");
      await loadIdentityCodes();
      await loadIdentityApplications();
    } catch (error) {
      byId("save-state").textContent = error.message;
    }
  }

  function editIdentityInformation(item) {
    state.selectedIdentityCode = item;
    const expired =
      item.status === "active" &&
      item.expires_at &&
      Date.parse(item.expires_at) <= Date.now();
    const detail = byId("identity-information-detail");
    detail.replaceChildren();
    for (const [label, value] of [
      ["身份识别码", item.code],
      [
        "识别码状态",
        item.status === "disabled" ? "取消" : expired ? "已过期" : "有效"
      ]
    ]) {
      detail.append(
        create("dt", "", window.MrzhI18n.t(label)),
        create("dd", "", window.MrzhI18n.t(value))
      );
    }
    byId("identity-information-player-name").value = item.player_name || "";
    byId("identity-information-email").value = item.email || "";
    byId("identity-information-locale").value = item.locale || "zh-cn";
    const permanent = !item.expires_at;
    byId("identity-information-permanent").checked = permanent;
    byId("identity-information-expiry").value = item.expires_at
      ? identityExpiryDate(item.expires_at)
      : identityExpiryDate();
    byId("identity-information-expiry").disabled = permanent;
    byId("identity-information-expiry").required = !permanent;
    setText("identity-information-feedback", "");
    byId("identity-information-dialog").showModal();
  }

  async function saveIdentityInformation(event) {
    event.preventDefault();
    const item = state.selectedIdentityCode;
    if (!item) return;
    const button =
      event.submitter ||
      event.currentTarget.querySelector('button[type="submit"]');
    const feedback = byId("identity-information-feedback");
    const permanent = byId("identity-information-permanent").checked;
    button.disabled = true;
    feedback.textContent = window.MrzhI18n.t("正在保存…");
    try {
      await request(
        `/api/admin/identity-codes/${encodeURIComponent(item.id)}/information`,
        {
          method: "PATCH",
          body: JSON.stringify({
            playerName: byId("identity-information-player-name").value.trim(),
            email: byId("identity-information-email").value.trim(),
            locale: byId("identity-information-locale").value,
            permanent,
            expiresOn: permanent
              ? null
              : byId("identity-information-expiry").value
          })
        }
      );
      byId("identity-information-dialog").close();
      byId("save-state").textContent = window.MrzhI18n.t("识别码资料已修改");
      await loadIdentityCodes();
      await loadIdentityApplications();
    } catch (error) {
      feedback.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  async function reissueIdentity(item) {
    const value = await showAppPrompt(
      window.MrzhI18n.t(
        "更换会立即作废旧识别码。请输入更换后识别码的有效日期（YYYY-MM-DD），或输入 permanent 设置为永久有效："
      ),
      {
        title: "更换识别码",
        inputLabel: "有效期",
        inputValue: item.expires_at ? identityExpiryDate(item.expires_at) : ""
      }
    );
    if (!value) return;
    if (!(await showAppConfirm(
      window.MrzhI18n.t(
        "确认作废旧识别码、生成更换后的识别码并发送识别码信息邮件？"
      ),
      { title: "更换识别码", danger: true }
    ))) {
      return;
    }
    try {
      const result = await request(
        `/api/admin/identity-codes/${encodeURIComponent(item.id)}/reissue`,
        {
          method: "POST",
          body: JSON.stringify({
            permanent: value.trim().toLowerCase() === "permanent",
            expiresOn:
              value.trim().toLowerCase() === "permanent"
                ? null
                : value.trim()
          })
        }
      );
      byId("save-state").textContent = result.emailSent
        ? window.MrzhI18n.t("识别码已更换，并已发送识别码信息邮件")
        : window.MrzhI18n.format(
            "识别码已更换，但信息邮件发送失败：{error}",
            { error: result.emailError }
          );
      await loadIdentityCodes();
    } catch (error) {
      byId("save-state").textContent = error.message;
    }
  }

  async function resendIdentity(id, button) {
    button.disabled = true;
    try {
      await request(`/api/admin/identity-codes/${encodeURIComponent(id)}/resend`, {
        method: "POST",
        body: "{}"
      });
      byId("save-state").textContent = window.MrzhI18n.t(
        "识别码信息邮件已重新发送"
      );
      await loadIdentityCodes();
    } catch (error) {
      byId("save-state").textContent = error.message;
      button.disabled = false;
    }
  }

  async function createManualIdentity(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const permanent = form.elements.identityPermanent.checked;
    try {
      const result = await request("/api/admin/identity-codes", {
        method: "POST",
        body: JSON.stringify({
          playerName: form.elements.identityPlayerName.value.trim(),
          email: form.elements.identityEmail.value.trim(),
          locale: form.elements.identityLocale.value,
          permanent,
          expiresOn: permanent
            ? null
            : form.elements.identityExpiresAt.value
        })
      });
      setText("manual-identity-feedback", `已生成：${result.code}`);
      await loadIdentityCodes(1);
    } catch (error) {
      setText("manual-identity-feedback", error.message);
    }
  }

  async function loadSmtpConfig(force = false) {
    if (!canView("smtp")) return;
    if (
      state.smtpConfigLoading ||
      (!force && (state.smtpConfigLoaded || state.smtpDirty))
    ) {
      return;
    }
    state.smtpConfigLoading = true;
    const revision = state.smtpDraftRevision;
    try {
      const config = await request("/api/admin/smtp-config");
      if (!force && revision !== state.smtpDraftRevision) {
        state.smtpDirty = true;
        return;
      }
      for (const [name, value] of Object.entries({
        smtpEnabled: config.enabled,
        smtpHost: config.host,
        smtpPort: config.port,
        smtpSecure: config.secure,
        smtpStartTls: config.startTls,
        smtpAuthType: config.authType,
        smtpUsername: config.username,
        smtpFromEmail: config.fromEmail,
        smtpFromName: config.fromName,
        smtpReplyTo: config.replyTo
      })) {
        setField(name, value);
      }
      input("smtpPassword").placeholder = config.passwordConfigured
        ? "已配置；留空则保留现有密码"
        : "尚未配置密码";
      state.smtpConfigLoaded = true;
      state.smtpDirty = false;
    } catch (error) {
      setText("smtp-feedback", error.message);
    } finally {
      state.smtpConfigLoading = false;
    }
  }

  async function saveSmtpConfig(event) {
    event.preventDefault();
    try {
      await request("/api/admin/smtp-config", {
        method: "PUT",
        body: JSON.stringify({
          enabled: getField("smtpEnabled"),
          host: getField("smtpHost"),
          port: Number(getField("smtpPort")),
          secure: getField("smtpSecure"),
          startTls: getField("smtpStartTls"),
          authType: getField("smtpAuthType"),
          username: getField("smtpUsername"),
          password: getField("smtpPassword"),
          fromEmail: getField("smtpFromEmail"),
          fromName: getField("smtpFromName"),
          replyTo: getField("smtpReplyTo")
        })
      });
      input("smtpPassword").value = "";
      input("smtpPassword").placeholder = "已配置；留空则保留现有密码";
      state.smtpConfigLoaded = true;
      state.smtpDirty = false;
      setText("smtp-feedback", "SMTP 配置已保存");
    } catch (error) {
      setText("smtp-feedback", error.message);
    }
  }

  async function sendSmtpTest(event) {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await request("/api/admin/smtp-config/test", {
        method: "POST",
        body: JSON.stringify({ to: form.elements.smtpTestTo.value.trim() })
      });
      setText("smtp-feedback", "测试邮件已发送");
    } catch (error) {
      setText("smtp-feedback", error.message);
    }
  }

  installAppModal();
  renderTaskActions();
  for (const form of document.querySelectorAll(".config-form")) {
    form.addEventListener("input", (event) => {
      if (event.target.closest("[data-ui-only]")) return;
      const section = form.dataset.configSection;
      state.dirtySections.add(section);
      form.querySelector("[data-save-feedback]").textContent = "有未保存修改";
      updateSaveState();
    });
    form.addEventListener("submit", saveConfig);
  }
  for (const button of document.querySelectorAll("[data-schedule-open]")) {
    button.addEventListener("click", () => openScheduleDialog(button.dataset.scheduleOpen));
  }
  byId("schedule-dialog-close")?.addEventListener("click", closeScheduleDialog);
  byId("schedule-add-time")?.addEventListener("click", addScheduleTime);
  byId("schedule-dialog-form")?.addEventListener("submit", saveScheduleDialog);
  for (const link of document.querySelectorAll("[data-nav-target]")) {
    link.addEventListener("click", () => {
      activateView(link.dataset.navTarget);
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }
  window.addEventListener("hashchange", () => {
    activateView(location.hash.slice(1) || "overview");
  });
  byId("admin-member-search").addEventListener("input", (event) => {
    state.memberQuery = event.target.value || "";
    renderAdminMembers(state.bootstrap?.members || []);
  });
  byId("member-dialog-edit")?.addEventListener("click", openMemberEdit);
  byId("member-edit-close")?.addEventListener("click", closeMemberEdit);
  byId("member-edit-cancel")?.addEventListener("click", closeMemberEdit);
  byId("member-edit-form")?.addEventListener("submit", saveMemberEdit);
  byId("technology-search").addEventListener("input", (event) => {
    state.technologyQuery = event.target.value || "";
    renderTechnologyEditor();
  });
  byId("technology-category-filter").addEventListener("change", (event) => {
    state.technologyCategory = event.target.value || "all";
    renderTechnologyEditor();
  });
  byId("technology-fixed-date")?.addEventListener("change", (event) => {
    const value = String(event.target.value || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
    state.technologyDate = value;
    renderTechnologyEditor();
  });
  byId("technology-add-preset")?.addEventListener("click", () => {
    if (!state.technologyDraft) return;
    const preset = createEmptyTechnologyPreset();
    state.technologyDraft.fixedPresets.push(preset);
    state.technologyPresetId = preset.id;
    markTechnologyDirty();
    renderTechnologyEditor();
  });
  byId("technology-delete-preset")?.addEventListener("click", async () => {
    const preset = selectedTechnologyPreset();
    if (!preset || selectedTechnologyPresetIsLocked(preset)) return;
    if (!(await showAppConfirm(
      `确定删除“${technologyPresetTitle(preset)}”吗？保存后该固定规则将永久移除。`,
      { title: "删除固定规则", danger: true }
    ))) return;
    const presets = state.technologyDraft.fixedPresets;
    const index = presets.findIndex((item) => item.id === preset.id);
    if (index >= 0) presets.splice(index, 1);
    state.technologyPresetId = presets[Math.max(0, index - 1)]?.id || presets[0]?.id || "";
    markTechnologyDirty();
    renderTechnologyEditor();
  });
  for (const [id, lane] of [
    ["technology-core-limit", "core"],
    ["technology-general-limit", "general"]
  ]) {
    byId(id).addEventListener("change", (event) => {
      if (!state.technologyDraft) return;
      state.technologyDraft.limits[lane] = Number(event.target.value);
      markTechnologyDirty();
      renderTechnologyEditor();
    });
  }
  input("voteWindowEnd")?.addEventListener("input", () => {
    const field = input("voteWindowEnd");
    if (!field) return;
    field.dataset.legacyValue = "";
  });
  byId("refresh-technology-history").addEventListener("click", () =>
    loadTechnologyHistory(byId("technology-history-date").value)
  );
  byId("delete-technology-history-date").addEventListener("click", () =>
    deleteTechnologyHistory(state.technologyHistory.history?.pollDate)
  );
  byId("delete-technology-history-all").addEventListener("click", () =>
    deleteTechnologyHistory("")
  );
  byId("daily-vote-new-poll")?.addEventListener("click", () =>
    openDailyVoteEditor(null, "poll")
  );
  byId("daily-vote-new-draw")?.addEventListener("click", () =>
    openDailyVoteEditor(null, "draw")
  );
  byId("daily-vote-cancel")?.addEventListener("click", closeDailyVoteEditor);
  byId("daily-vote-kind")?.addEventListener("change", toggleDailyVoteEditorFields);
  byId("daily-vote-editor")?.addEventListener("submit", saveDailyVoteFromEditor);
  byId("daily-vote-config-form")?.addEventListener("submit", saveDailyVoteConfig);
  byId("refresh-daily-vote")?.addEventListener("click", () =>
    loadDailyVoteAdmin("", 1, "active")
  );
  byId("daily-vote-prev")?.addEventListener("click", () =>
    loadDailyVoteAdmin("", state.dailyVotePage - 1, "active")
  );
  byId("daily-vote-next")?.addEventListener("click", () =>
    loadDailyVoteAdmin("", state.dailyVotePage + 1, "active")
  );
  byId("daily-vote-jump-button")?.addEventListener("click", () =>
    loadDailyVoteAdmin("", Number(byId("daily-vote-jump").value), "active")
  );
  byId("refresh-daily-vote-history")?.addEventListener("click", () =>
    loadDailyVoteAdmin(byId("daily-vote-history-date").value, 1, "history")
  );
  byId("daily-vote-history-prev")?.addEventListener("click", () =>
    loadDailyVoteAdmin(
      byId("daily-vote-history-date").value,
      state.dailyVoteHistoryPage - 1,
      "history"
    )
  );
  byId("daily-vote-history-next")?.addEventListener("click", () =>
    loadDailyVoteAdmin(
      byId("daily-vote-history-date").value,
      state.dailyVoteHistoryPage + 1,
      "history"
    )
  );
  byId("daily-vote-history-jump-button")?.addEventListener("click", () =>
    loadDailyVoteAdmin(
      byId("daily-vote-history-date").value,
      Number(byId("daily-vote-history-jump").value),
      "history"
    )
  );
  byId("delete-daily-vote-history-date")?.addEventListener("click", () =>
    deleteDailyVoteHistoryAdmin(byId("daily-vote-history-date").value)
  );
  byId("delete-daily-vote-history-all")?.addEventListener("click", () =>
    deleteDailyVoteHistoryAdmin("")
  );
  byId("public-content-locale").addEventListener("change", (event) => {
    switchPublicContentLocale(event.target.value);
  });
  byId("refresh-admin").addEventListener("click", () => refresh(false));
  byId("logout").addEventListener("click", logout);
  byId("temporary-key-form").addEventListener("submit", generateTemporaryKey);
  byId("temporary-key-permissions-form").addEventListener(
    "submit",
    saveTemporaryKeyPermissions
  );
  byId("temporary-key-permissions-close").addEventListener("click", () =>
    byId("temporary-key-permissions-dialog").close()
  );
  byId("temporary-key-permissions-dialog").addEventListener("close", () => {
    state.editingTemporaryKeyId = null;
    byId("temporary-key-permissions-feedback").textContent = "";
  });
  byId("temporary-key-search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    state.temporaryKeySearch = byId("temporary-key-search").value.trim();
    loadTemporaryKeys(1);
  });
  byId("temporary-key-status").addEventListener("change", (event) => {
    state.temporaryKeyStatus = event.target.value;
    loadTemporaryKeys(1);
  });
  byId("temporary-key-prev").addEventListener("click", () =>
    loadTemporaryKeys(state.temporaryKeys.page - 1)
  );
  byId("temporary-key-next").addEventListener("click", () =>
    loadTemporaryKeys(state.temporaryKeys.page + 1)
  );
  byId("temporary-key-jump-button").addEventListener("click", () =>
    loadTemporaryKeys(Number(byId("temporary-key-jump").value))
  );
  input("keyPermanent").addEventListener("change", (event) => {
    input("keyExpiresAt").disabled = event.target.checked;
    input("keyExpiresAt").required = !event.target.checked;
  });
  for (const field of document.querySelectorAll('[name="keyPermission"]')) {
    field.addEventListener("change", () => {
      const demo = document.querySelector(
        '[name="keyPermission"][value="demo:preview"]'
      );
      if (field === demo && field.checked) {
        for (const other of document.querySelectorAll('[name="keyPermission"]')) {
          if (other !== demo) other.checked = false;
        }
      } else if (field.checked && demo) {
        demo.checked = false;
      }
    });
  }
  for (const field of document.querySelectorAll('[name="keyEditPermission"]')) {
    field.addEventListener("change", () => {
      const demo = document.querySelector(
        '[name="keyEditPermission"][value="demo:preview"]'
      );
      if (field === demo && field.checked) {
        for (const other of document.querySelectorAll('[name="keyEditPermission"]')) {
          if (other !== demo) other.checked = false;
        }
      } else if (field.checked && demo) {
        demo.checked = false;
      }
    });
  }
  byId("run-dialog").addEventListener("close", stopEventRefresh);
  byId("vote-detail-dialog").addEventListener("close", () => {
    state.activeVoteDetail = null;
    state.activeDailyVoteDetail = null;
  });
  byId("clear-rate-limits").addEventListener("click", () =>
    openMaintenanceDialog("rate-limits")
  );
  byId("clear-run-history").addEventListener("click", () =>
    openMaintenanceDialog("run-history")
  );
  byId("maintenance-confirm").addEventListener("click", confirmMaintenance);
  byId("maintenance-dialog").addEventListener("close", () => {
    state.maintenanceAction = null;
    byId("maintenance-feedback").textContent = "";
  });
  document.addEventListener("click", closeRunActionMenu);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeRunActionMenu();
  });
  window.addEventListener("resize", positionRunActionMenu);
  window.addEventListener("scroll", positionRunActionMenu, true);
  byId("copy-temporary-key").addEventListener("click", async () => {
    await navigator.clipboard.writeText(byId("temporary-key-value").textContent);
    byId("save-state").textContent = "临时 Key 已复制";
  });
  byId("refresh-identity-applications").addEventListener("click", () =>
    loadIdentityApplications()
  );
  byId("identity-application-search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    state.identityApplicationSearch = byId("identity-application-search").value.trim();
    loadIdentityApplications(1);
  });
  byId("identity-application-status").addEventListener("change", (event) => {
    state.identityApplicationStatus = event.target.value;
    loadIdentityApplications(1);
  });
  byId("identity-app-prev").addEventListener("click", () =>
    loadIdentityApplications(state.identityApplications.page - 1)
  );
  byId("identity-app-next").addEventListener("click", () =>
    loadIdentityApplications(state.identityApplications.page + 1)
  );
  byId("identity-app-jump-button").addEventListener("click", () =>
    loadIdentityApplications(Number(byId("identity-app-jump").value))
  );
  byId("identity-review-close").addEventListener("click", () =>
    byId("identity-review-dialog").close()
  );
  byId("identity-review-approve").addEventListener("click", () =>
    reviewIdentity("approve")
  );
  byId("identity-review-reject").addEventListener("click", () =>
    reviewIdentity("reject")
  );
  for (const field of document.querySelectorAll('[name="eligibilityApprovalMode"]')) {
    field.addEventListener("change", () => {
      const votes = byId("identity-eligibility-votes-mode").checked;
      const date = byId("identity-eligibility-date-mode").checked;
      byId("identity-eligibility-approved-votes").disabled = !votes;
      byId("identity-eligibility-approved-until").disabled = !date;
    });
  }
  byId("identity-eligibility-edit-save").addEventListener(
    "click",
    saveIdentityVoteEligibility
  );
  byId("identity-information-close").addEventListener("click", () =>
    byId("identity-information-dialog").close()
  );
  byId("identity-information-form").addEventListener(
    "submit",
    saveIdentityInformation
  );
  byId("identity-information-permanent").addEventListener("change", (event) => {
    byId("identity-information-expiry").disabled = event.target.checked;
    byId("identity-information-expiry").required = !event.target.checked;
  });
  byId("manual-identity-code-form").addEventListener("submit", createManualIdentity);
  byId("identity-code-search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    state.identityCodeSearch = byId("identity-code-search").value.trim();
    loadIdentityCodes(1);
  });
  byId("identity-code-status").addEventListener("change", (event) => {
    state.identityCodeStatus = event.target.value;
    loadIdentityCodes(1);
  });
  byId("identity-code-prev").addEventListener("click", () =>
    loadIdentityCodes(state.identityCodes.page - 1)
  );
  byId("identity-code-next").addEventListener("click", () =>
    loadIdentityCodes(state.identityCodes.page + 1)
  );
  byId("identity-code-jump-button").addEventListener("click", () =>
    loadIdentityCodes(Number(byId("identity-code-jump").value))
  );
  byId("identity-password-reset-cancel").addEventListener("click", () =>
    byId("identity-password-reset-dialog").close()
  );
  byId("identity-password-reset-confirm").addEventListener("click", confirmIdentityPasswordReset);
  byId("identity-password-reset-dialog").addEventListener("close", () => {
    state.selectedIdentityPasswordResetCode = null;
    setText("identity-password-reset-feedback", "");
  });
  byId("smtp-config-form").addEventListener("submit", saveSmtpConfig);
  byId("smtp-config-form").addEventListener("input", () => {
    state.smtpDraftRevision += 1;
    state.smtpDirty = true;
    setText("smtp-feedback", "有未保存修改");
  });
  byId("smtp-test-form").addEventListener("submit", sendSmtpTest);
  input("identityPermanent").addEventListener("change", (event) => {
    input("identityExpiresAt").disabled = event.target.checked;
  });
  byId("identity-review-permanent").addEventListener("change", (event) => {
    byId("identity-review-expiry").disabled = event.target.checked;
  });
  document.addEventListener("mrzh:languagechange", () => {
    if (state.bootstrap) render(state.bootstrap, []);
    if (state.activeEventRunId && byId("run-dialog").open) {
      // The event endpoint is locale-aware. Reload the current timeline from
      // the beginning so already-loaded rows change language immediately.
      state.eventSignature = "";
      state.eventEntries = [];
      state.eventLastId = null;
      state.eventLoaded = false;
      state.eventLocaleRevision += 1;
      void refreshRunEvents(state.activeEventRunId);
    }
    refresh(false);
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      state.liveDirty = true;
      flushLiveRefresh();
      connectLiveUpdates();
    }
  });
  refresh(true);
  connectLiveUpdates();
})();
