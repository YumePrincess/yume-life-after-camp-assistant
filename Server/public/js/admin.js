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
    ["patrol", "营地巡逻", "组队、困难路线与定时古籍分享"]
  ];
  const CONFIG_SECTIONS = ["general", "tasks", "agent", "technology"];
  const VIEW_PERMISSIONS = {
    overview: "admin:overview",
    general: "admin:general",
    tasks: "admin:tasks",
    agent: "admin:agent",
    plugins: "admin:plugins",
    technology: "admin:technology",
    "technology-history": "admin:technology-history",
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
    memberQuery: "",
    selectedMember: null,
    technologyDate: "",
    technologyDraft: null,
    technologyQuery: "",
    technologyCategory: "all",
    technologyHistory: { dates: [], history: null },
    technologyHistoryLoading: false,
    activeView: "overview",
    accessAllowed: false,
    activeEventRunId: null,
    eventRefreshTimer: null,
    eventRefreshInFlight: false,
    eventSignature: "",
    runActionMenu: null,
    identityApplications: { page: 1, total: 0, items: [] },
    identityCodes: { page: 1, total: 0, items: [] },
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
    publicContentLocale: "zh-cn",
    publicContentDraft: null,
    smtpConfigLoaded: false,
    smtpConfigLoading: false,
    smtpDraftRevision: 0,
    smtpDirty: false,
    scheduleDrafts: {},
    scheduleDialogTaskKey: null,
    maintenanceAction: null,
    loadedPluginClientModules: new Set()
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function create(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function createRunActionButton(label, className, icon) {
    const button = create(
      "button",
      `button run-action-button ${className}`.trim()
    );
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
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
    button.append(svg, create("span", "run-action-label", label));
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
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  }

  function taskName(value) {
    const task = (state.bootstrap?.plugins || [])
      .flatMap((plugin) => plugin.tasks || [])
      .find((item) => item.key === value);
    return task?.name || TASK_NAMES[value] || value;
  }

  function permissionName(value) {
    return state.bootstrap?.permissionCatalog?.find((item) => item.key === value)?.label || (
      {
        "demo:preview": "Demo · 全后台只读",
        "admin:overview": "控制台",
        "admin:general": "基础设置",
        "admin:tasks": "任务计划",
        "admin:agent": "执行策略",
        "admin:plugins": "Workers 插件",
        "admin:technology": "科技管理",
        "admin:technology-history": "科技投票历史",
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
    return {
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

  function updateSaveState(fallback = "") {
    if (!state.dirtySections.size) {
      byId("save-state").textContent = fallback;
      return;
    }
    byId("save-state").textContent =
      state.dirtySections.size === 1
        ? "有 1 个分区未保存"
        : `有 ${state.dirtySections.size} 个分区未保存`;
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
      card.append(create("h3", "", name), create("p", "", copy), button);
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
        item.key === "demo:preview" || item.key.startsWith("admin:") || item.key.startsWith("plugin:") || item.key === "technology-history:manage"
      )) {
        const label = create("label");
        const checkbox = create("input");
        checkbox.type = "checkbox";
        checkbox.name = name;
        checkbox.value = permission.key;
        label.append(checkbox, create("span", "", permission.label));
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
        create("strong", "", `${plugin.displayName} · ${plugin.version} (Build ${plugin.build})`),
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
        create("span", "muted", `${(plugin.tasks || []).length} 个任务 · ${(plugin.permissions || []).length} 项权限`),
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
            ? `${taskName(item.active_task_key)} / ${item.status}`
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
    if (!confirm(window.MrzhI18n.format(
      "确认删除设备 {name}？设备再次上线后会自动重新出现。",
      { name }
    ))) return;
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
        voteWindowStart: camp.voteWindowStart || "06:30",
        voteWindowEnd: camp.voteWindowEnd || "24:00",
        currentCampType: camp.currentCampType,
        publicMembersEnabled: camp.publicMembersEnabled,
        inactivityWarningDays: camp.inactivityWarningDays,
        temporaryKeyLoginEnabled: bundle.authConfig.temporaryKeyLoginEnabled,
        announcement:
          state.publicContentDraft[state.publicContentLocale]?.announcement || "",
        highlights:
          (state.publicContentDraft[state.publicContentLocale]?.highlights || []).join("\n\n")
      })) {
        setField(name, value);
      }
    }
    if (sections.includes("tasks")) {
      state.scheduleDrafts = {};
      for (const [name, value] of Object.entries({
        scheduledRetryCount: automation.scheduledRetryCount ?? 2,
        techEnabled: tasks.tech_switch.enabled,
        techTime: tasks.tech_switch.time,
        contributionEnabled: tasks.contribution_sync.enabled,
        contributionTime: tasks.contribution_sync.time,
        inactivityEnabled: tasks.inactivity_sync.enabled,
        inactivityTime: tasks.inactivity_sync.time,
        profileEnabled: tasks.member_profile_sync.enabled,
        profileTime: tasks.member_profile_sync.time,
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
      }
      renderScheduleSummaries();
    }
    if (sections.includes("agent")) {
      for (const [name, value] of Object.entries({
        pollActiveSeconds: automation.agentPolling.activeSeconds,
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
      state.technologyDraft = JSON.parse(JSON.stringify(bundle.technologyConfig));
      state.technologyDraft.fixedByDate ||= {};
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
      if (feedback) feedback.textContent = "当前配置已同步";
    }
  }

  const SCHEDULE_FIELDS = {
    tech_switch: { enabled: "techEnabled", time: "techTime", title: "科技切换" },
    contribution_sync: { enabled: "contributionEnabled", time: "contributionTime", title: "更新贡献" },
    inactivity_sync: { enabled: "inactivityEnabled", time: "inactivityTime", title: "更新斩杀预警" },
    member_profile_sync: { enabled: "profileEnabled", time: "profileTime", title: "更新成员资料" },
    patrol: { enabled: "patrolEnabled", time: "patrolTime", title: "营地巡逻" }
  };

  function scheduleTimes(taskKey) {
    const field = SCHEDULE_FIELDS[taskKey];
    const values = state.scheduleDrafts[taskKey];
    if (Array.isArray(values) && values.length) return values;
    return [String(getField(field?.time) || "").trim()];
  }

  function renderScheduleSummaries() {
    for (const [taskKey, field] of Object.entries(SCHEDULE_FIELDS)) {
      const times = scheduleTimes(taskKey).filter(Boolean);
      const summary = document.querySelector(`[data-schedule-summary="${taskKey}"]`);
      if (summary) {
        summary.textContent = taskKey === "patrol"
          ? window.MrzhI18n.format("启动时间：{time}", { time: times[0] || window.MrzhI18n.t("未设置") })
          : window.MrzhI18n.format("执行 {count} 次：{times}", {
              count: times.length || 1,
              times: times.join("、") || window.MrzhI18n.t("未设置")
            });
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
    byId("schedule-dialog-title").textContent = `${window.MrzhI18n.t(field.title)}：${window.MrzhI18n.t("配置执行计划")}`;
    byId("schedule-dialog-note").textContent = taskKey === "patrol"
      ? window.MrzhI18n.t("巡逻任务只支持一个启动时间。")
      : taskKey === "tech_switch"
        ? window.MrzhI18n.t("科技切换任务只支持一个执行时间。")
        : window.MrzhI18n.t("默认保留当前时间。增加执行次数后，请分别设置每次执行时间。手动发起任务不使用失败重试。");
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
    const invalid = times.some((value) => !/^([01]\\d|2[0-3]):[0-5]\\d$/.test(value));
    if (!times.length || invalid) {
      byId("schedule-dialog-feedback").textContent = window.MrzhI18n.t("请为每次执行填写有效时间。");
      return;
    }
    const normalized = taskKey === "tech_switch" || taskKey === "patrol" ? [times[0]] : times;
    state.scheduleDrafts[taskKey] = normalized;
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
    document.querySelector('.config-form[data-config-section="tasks"] [data-save-feedback]')?.replaceChildren(document.createTextNode("有未保存修改"));
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
            )
          )
        );
      }
      root.append(item);
    }
  }

  function historyTechnologyItem(item, tag = "article") {
    const card = create(tag, "technology-history-tech");
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
    for (const item of items) root.append(historyTechnologyItem(item));
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
    if (!history) return;
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
            )
          )
        );
        row.append(
          historyTechnologyItem(item, "span"),
          create(
            "strong",
            "technology-history-vote-count",
            window.MrzhI18n.format("{count} 票", { count: item.votes })
          )
        );
        votes.append(row);
      }
    }
  }

  async function loadTechnologyHistory(date = "") {
    if (!canView("technology-history") || state.technologyHistoryLoading) return;
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
      byId("technology-history-status").textContent = payload.history
        ? window.MrzhI18n.t("已载入最终归档")
        : window.MrzhI18n.t("暂无可查询记录");
    } catch (error) {
      byId("technology-history-status").textContent = error.message;
    } finally {
      state.technologyHistoryLoading = false;
      renderTechnologyHistory(state.technologyHistory);
    }
  }

  async function deleteTechnologyHistory(date) {
    const deletingAll = !date;
    const label = deletingAll
      ? window.MrzhI18n.t("全部历史投票结果")
      : window.MrzhI18n.format("{date} 的历史投票结果", { date });
    if (
      !window.confirm(
        window.MrzhI18n.format("确认删除{label}吗？删除后无法从后台恢复。", { label })
      )
    ) return;
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
      await loadTechnologyHistory();
    } catch (error) {
      byId("technology-history-status").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  function openVoteDetails(option, ballots) {
    byId("vote-detail-title").textContent = option.name;
    byId("vote-detail-summary").textContent =
      window.MrzhI18n.format(
        "共 {count} 票；同一识别码重复投票时仅保留最后一次提交。",
        { count: ballots.length }
      );
    const root = byId("vote-detail-list");
    root.replaceChildren();
    if (!ballots.length) {
      root.append(create("p", "empty-state", window.MrzhI18n.t("暂无投票记录")));
    } else {
      for (const ballot of ballots) {
        const item = create("article", "vote-detail-item");
        const identity = create("code", "vote-detail-code", ballot.identityCode || "—");
        const player = create("strong", "vote-detail-player", ballot.playerName || "—");
        const time = create("time", "muted", formatVoteDate(ballot.votedAt));
        item.append(identity, player, time);
        root.append(item);
      }
    }
    byId("vote-detail-dialog").showModal();
  }

  function datePlusDays(dateKey, days) {
    const date = new Date(`${dateKey}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  function markTechnologyDirty() {
    state.dirtySections.add("technology");
    updateSaveState();
    const feedback = document
      .querySelector('[data-config-section="technology"]')
      ?.querySelector("[data-save-feedback]");
    if (feedback) feedback.textContent = "科技配置尚未保存";
  }

  function renderTechnologyEditor() {
    const config = state.technologyDraft;
    if (!config) return;
    const campType =
      state.bootstrap?.configBundle?.campConfig?.currentCampType ||
      "agriculture";
    const effectiveLane = (item) =>
      item.category === campType ? "core" : "general";
    const coreLabel = `${categoryLabel(campType)}科技`;
    const weekdayRoot = byId("technology-weekdays");
    weekdayRoot.replaceChildren();
    const firstDate =
      state.bootstrap?.voteSummary?.pollDate ||
      state.bootstrap?.nextTechnologyTargetDate ||
      identityExpiryDate(new Date());
    const allowedDates = new Set(
      Array.from({ length: 7 }, (_, index) => datePlusDays(firstDate, index))
    );
    config.fixedByDate = Object.fromEntries(
      Object.entries(config.fixedByDate || {}).filter(([date]) =>
        allowedDates.has(date)
      )
    );
    for (const date of allowedDates) {
      config.fixedByDate[date] ||= [];
    }
    if (!state.technologyDate) state.technologyDate = firstDate;
    Array.from({ length: 7 }, (_, index) => {
      const date = datePlusDays(firstDate, index);
      const weekday = new Intl.DateTimeFormat("zh-CN", {
        weekday: "short",
        timeZone: "UTC"
      }).format(new Date(`${date}T00:00:00Z`));
      const name = `${index === 0 ? "次日 · " : ""}${date.slice(5)} ${weekday}`;
      const button = create("button", "weekday-tab", name);
      button.type = "button";
      button.dataset.active = String(state.technologyDate === date);
      button.addEventListener("click", () => {
        state.technologyDate = date;
        renderTechnologyEditor();
      });
      weekdayRoot.append(button);
    });

    const fixed = new Set(
      config.fixedByDate[state.technologyDate] || []
    );
    const coreCount = config.catalog.filter(
      (item) => fixed.has(item.key) && effectiveLane(item) === "core"
    ).length;
    const generalCount = config.catalog.filter(
      (item) => fixed.has(item.key) && effectiveLane(item) === "general"
    ).length;
    byId("technology-core-count").textContent =
      `${coreLabel} ${coreCount} / ${config.limits.core}`;
    byId("technology-general-count").textContent =
      `其他科技 ${generalCount} / ${config.limits.general}`;

    const previewRoot = byId("technology-fixed-preview");
    previewRoot.replaceChildren();
    const currentVoteSummary = state.bootstrap?.voteSummary;
    const showsCurrentProjection =
      state.technologyDate === currentVoteSummary?.pollDate;
    const projectedOrderByLane = new Map(
      ["core", "general"].map((lane) => [
        lane,
        showsCurrentProjection
          ? (currentVoteSummary?.projectedPlan?.[lane] || []).map(
              (item) => item.key
            )
          : []
      ])
    );
    for (const lane of ["core", "general"]) {
      const projectedOrder = projectedOrderByLane.get(lane);
      const projectedKeys = new Set(projectedOrder);
      const selected = config.catalog
        .filter((item) =>
          showsCurrentProjection
            ? projectedKeys.has(item.key)
            : fixed.has(item.key) && effectiveLane(item) === lane
        )
        .sort((a, b) =>
          showsCurrentProjection
            ? projectedOrder.indexOf(a.key) - projectedOrder.indexOf(b.key)
            : a.sortOrder - b.sortOrder
        );
      const laneRoot = create("section", "technology-fixed-lane");
      const laneHeader = create("div", "technology-fixed-lane-header");
      laneHeader.append(
        create(
          "strong",
          "",
          lane === "core" ? `${coreLabel}行` : "其他科技行"
        ),
        create(
          "span",
          "",
          `${selected.length} / ${config.limits[lane]}`
        )
      );
      const slots = create("div", "technology-fixed-slots");
      for (let index = 0; index < config.limits[lane]; index += 1) {
        const item = selected[index];
        const slot = create("div", "technology-fixed-slot");
        slot.dataset.filled = String(Boolean(item));
        slot.dataset.source = item
          ? fixed.has(item.key)
            ? "fixed"
            : "vote"
          : "empty";
        slot.title = item
          ? `${item.name} · ${fixed.has(item.key) ? "固定科技" : "投票科技"}`
          : window.MrzhI18n.t("空位");
        if (item?.iconUrl) {
          const image = document.createElement("img");
          image.src = item.iconUrl;
          image.alt = item.name;
          image.loading = "lazy";
          slot.append(image);
        } else if (item) {
          slot.append(create("span", "", item.name.slice(0, 1)));
        } else {
          slot.append(create("span", "", "+"));
        }
        slots.append(slot);
      }
      laneRoot.append(laneHeader, slots);
      previewRoot.append(laneRoot);
    }

    const root = byId("technology-catalog-grid");
    root.replaceChildren();
    byId("technology-empty").hidden = Boolean(config.catalog.length);
    const normalizedQuery = state.technologyQuery.trim().toLocaleLowerCase();
    const filteredCatalog = config.catalog.filter((item) => {
      if (
        state.technologyCategory !== "all" &&
        item.category !== state.technologyCategory
      ) {
        return false;
      }
      if (!normalizedQuery) return true;
      return [item.name, item.description, item.uiLabel]
        .filter(Boolean)
        .some((value) =>
          String(value).toLocaleLowerCase().includes(normalizedQuery)
        );
    });
    byId("technology-filter-empty").hidden =
      !config.catalog.length || Boolean(filteredCatalog.length);
    byId("technology-result-count").textContent = window.MrzhI18n.format(
      "显示 {count} / {total} 项科技",
      {
        count: filteredCatalog.length,
        total: config.catalog.length
      }
    );
    for (const item of [...filteredCatalog].sort(
      (a, b) => a.sortOrder - b.sortOrder
    )) {
      const card = create("article", "technology-admin-card");
      card.dataset.fixed = String(fixed.has(item.key));
      const image = document.createElement(item.iconUrl ? "img" : "span");
      image.className = "tech-icon technology-admin-icon";
      if (item.iconUrl) {
        image.src = item.iconUrl;
        image.alt = "";
        image.loading = "lazy";
      } else {
        image.textContent = item.name.slice(0, 1);
      }
      const copy = create("div", "technology-admin-copy");
      copy.append(
        create("strong", "", item.name),
        create(
          "small",
          "",
          `${categoryLabel(item.category)} · ${
            effectiveLane(item) === "core" ? `${coreLabel}行` : "其他科技行"
          }`
        ),
        create("p", "", item.description || "暂无科技描述")
      );
      const controls = create("div", "technology-admin-controls");
      const fixedLabel = create("label", "technology-toggle");
      const fixedInput = document.createElement("input");
      fixedInput.type = "checkbox";
      fixedInput.checked = fixed.has(item.key);
      fixedInput.addEventListener("change", () => {
        const keys = new Set(
          config.fixedByDate[state.technologyDate] || []
        );
        if (fixedInput.checked) {
          const itemLane = effectiveLane(item);
          const laneCount = config.catalog.filter(
            (technology) =>
              keys.has(technology.key) &&
              effectiveLane(technology) === itemLane
          ).length;
          const limit = config.limits[itemLane];
          if (laneCount >= limit) {
            fixedInput.checked = false;
            alert(`${itemLane === "core" ? coreLabel : "其他科技"}最多固定 ${limit} 项`);
            return;
          }
          keys.add(item.key);
        } else {
          keys.delete(item.key);
        }
        config.fixedByDate[state.technologyDate] = [...keys];
        markTechnologyDirty();
        renderTechnologyEditor();
      });
      fixedLabel.append(fixedInput, document.createTextNode(" 固定"));

      const voteLabel = create("label", "technology-toggle");
      const voteInput = document.createElement("input");
      voteInput.type = "checkbox";
      voteInput.checked = item.enabledForVoting;
      voteInput.addEventListener("change", () => {
        item.enabledForVoting = voteInput.checked;
        markTechnologyDirty();
      });
      voteLabel.append(voteInput, document.createTextNode(" 开放投票"));

      const laneSelect = document.createElement("select");
      laneSelect.className = "technology-lane-select";
      laneSelect.innerHTML =
        `<option value="core">${coreLabel}行</option><option value="general">其他科技行</option>`;
      laneSelect.value = effectiveLane(item);
      laneSelect.disabled = true;
      laneSelect.title = "科技所在行由营地科技类型自动决定";
      controls.append(fixedLabel, voteLabel, laneSelect);
      card.append(image, copy, controls);
      root.append(card);
    }
  }

  function categoryLabel(category) {
    return {
      agriculture: "农业",
      military: "军事",
      industry: "工业"
    }[category] || category;
  }

  function renderRuns(runs) {
    closeRunActionMenu();
    const root = byId("run-table");
    root.replaceChildren();
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
    document.body.append(menu);
    trigger.setAttribute("aria-expanded", "true");
    state.runActionMenu = { menu, trigger };
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
    if (resolved === "identity-applications" && canView(resolved)) {
      loadIdentityApplications();
    }
    if (resolved === "identity-codes" && canView(resolved)) {
      loadIdentityCodes();
    }
    if (resolved === "smtp" && canView(resolved)) {
      loadSmtpConfig();
    }
    if (resolved === "access" && canView(resolved)) loadTemporaryKeys();
    if (resolved === "technology-history" && canView(resolved)) {
      loadTechnologyHistory();
    }
  }

  function render(data, fillSections = []) {
    state.bootstrap = data;
    document.documentElement.dataset.timezone =
      data.configBundle?.campConfig?.timezone || "Asia/Shanghai";
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
      ["#smtp-config-form input, #smtp-config-form select, #smtp-config-form button, #smtp-test-form input, #smtp-test-form button", "smtp:manage"]
    ]) {
      for (const control of document.querySelectorAll(selector)) {
        control.disabled = !hasPermission(permission);
      }
    }
    byId("clear-rate-limits").disabled = !hasPermission("admin:history");
    byId("clear-run-history").disabled = !hasPermission("admin:history");
    const canManageTechnologyHistory = hasPermission("technology-history:manage");
    byId("delete-technology-history-date").hidden = !canManageTechnologyHistory;
    byId("delete-technology-history-all").hidden = !canManageTechnologyHistory;
    byId("delete-technology-history-date").disabled =
      !canManageTechnologyHistory || !state.technologyHistory.history;
    byId("delete-technology-history-all").disabled =
      !canManageTechnologyHistory || !(state.technologyHistory.dates || []).length;
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
        const revoke = create("button", "button button-danger", "撤销");
        revoke.type = "button";
        revoke.hidden = !hasPermission("keys:manage");
        revoke.disabled = Boolean(item.revoked_at);
        revoke.addEventListener("click", () => revokeTemporaryKey(item.id, revoke));
        actions.append(edit, revoke);
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
        item.profession || "—",
        item.manor_level ?? "—",
        item.roommate_name || "—",
        item.weekly_contribution ?? 0,
        item.technology_points_used ?? 0,
        item.material_contribution ?? 0
      ]) {
        row.append(create("td", "", String(value)));
      }
      row.addEventListener("click", () => showMember(item));
      root.append(row);
    }
  }

  function showMember(member) {
    state.selectedMember = member;
    byId("member-dialog-title").textContent = member.name;
    const detail = byId("member-detail");
    detail.replaceChildren();
    for (const [label, value] of [
      ["营地称号", member.camp_title],
      ["职业", member.profession],
      ["庄园等级", member.manor_level],
      ["同居", member.roommate_name],
      ["本周贡献", member.weekly_contribution],
      ["使用科技点", member.technology_points_used],
      ["贡献物资", member.material_contribution],
      ["资料采集时间", formatDate(member.last_seen_at)]
    ]) {
      detail.append(create("dt", "", label), create("dd", "", String(value ?? "—")));
    }
    byId("member-dialog").showModal();
  }

  async function refresh(forceAll = false) {
    if (state.refreshing || state.saving) return;
    state.refreshing = true;
    try {
      const data = await request(
        `/api/admin/bootstrap?t=${Date.now()}&locale=${encodeURIComponent(window.MrzhI18n.language())}`
      );
      const sections = forceAll
        ? CONFIG_SECTIONS
        : CONFIG_SECTIONS.filter(
            (section) => !state.dirtySections.has(section)
          );
      render(data, sections);
    } catch (error) {
      byId("save-state").textContent = error.message;
    } finally {
      state.refreshing = false;
    }
  }

  async function runTask(taskKey, button, routineId) {
    button.disabled = true;
    try {
      await request("/api/admin/run", {
        method: "POST",
        body: JSON.stringify({
          taskKey,
          locale: window.MrzhI18n.language(),
          ...(routineId ? { routineId } : {})
        })
      });
      byId("save-state").textContent = window.MrzhI18n.format(
        "{task}已入队",
        { task: taskName(taskKey) }
      );
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
    const root = byId("run-events");
    root.replaceChildren(create("p", "empty-state", "正在加载…"));
    byId("run-dialog").showModal();
    await refreshRunEvents(runId);
    if (state.activeEventRunId === runId && byId("run-dialog").open) {
      state.eventRefreshTimer = window.setInterval(
        () => refreshRunEvents(runId),
        2_000
      );
    }
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
    try {
      const payload = await request(`/api/admin/runs/${encodeURIComponent(runId)}/events`);
      if (state.activeEventRunId !== runId) return;
      const signature = JSON.stringify(
        payload.events.map((event) => [
          event.id,
          event.level,
          event.step,
          event.message,
          event.created_at
        ])
      );
      if (signature === state.eventSignature) return;
      state.eventSignature = signature;
      root.replaceChildren();
      if (!payload.events.length) {
        root.append(create("p", "empty-state", "暂无步骤事件。"));
      }
      for (const event of payload.events) {
        const row = create("article", "event-item");
        row.append(
          create("span", `status-${event.level}`, event.level),
          create("time", "muted", formatDate(event.created_at)),
          create("span", "", `${event.step ? `[${event.step}] ` : ""}${event.message}`)
        );
        root.append(row);
      }
    } catch (error) {
      if (state.activeEventRunId === runId) {
        root.replaceChildren(create("p", "error-text", error.message));
      }
    } finally {
      state.eventRefreshInFlight = false;
    }
  }

  function stopEventRefresh() {
    if (state.eventRefreshTimer) {
      window.clearInterval(state.eventRefreshTimer);
      state.eventRefreshTimer = null;
    }
    state.activeEventRunId = null;
    state.eventSignature = "";
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
        voteWindowStart: String(getField("voteWindowStart")).trim(),
        voteWindowEnd: String(getField("voteWindowEnd")).trim(),
        currentCampType: getField("currentCampType"),
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
      next.automationConfig.tasks = {
        tech_switch: {
          enabled: getField("techEnabled"),
          time: techTimes[0],
          times: techTimes
        },
        contribution_sync: {
          enabled: getField("contributionEnabled"),
          time: contributionTimes[0],
          times: contributionTimes
        },
        inactivity_sync: {
          enabled: getField("inactivityEnabled"),
          time: inactivityTimes[0],
          times: inactivityTimes
        },
        member_profile_sync: {
          enabled: getField("profileEnabled"),
          time: profileTimes[0],
          times: profileTimes
        },
        patrol: {
          enabled: getField("patrolEnabled"),
          time: patrolTime,
          times: [patrolTime],
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
      next.technologyConfig = JSON.parse(
        JSON.stringify(state.technologyDraft)
      );
    } else {
      throw new Error("未知配置分区");
    }
    return next;
  }

  function capturePublicContentDraft() {
    if (!state.publicContentDraft) return;
    state.publicContentDraft[state.publicContentLocale] = {
      announcement: String(getField("announcement") || "").trim(),
      highlights: String(getField("highlights") || "")
        .split(/\n\s*\n/)
        .map((value) => value.trim())
        .filter(Boolean)
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
    setField("highlights", content.highlights.join("\n\n"));
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
    root.replaceChildren();
    for (const item of payload.items) {
      const row = document.createElement("tr");
      for (const value of [
        item.application_number,
        item.request_type === "renewal" ? "延期" : "新申请",
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
      operation.disabled =
        item.status !== "pending" || !hasPermission("identity:review");
      operation.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleActionMenu(operation, [
          {
            label: "审批",
            icon: "events",
            onSelect: () => openIdentityReview(item)
          }
        ]);
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
    setText(
      "identity-review-title",
      item.request_type === "renewal"
        ? "审批延期申请"
        : item.request_type === "reissue"
          ? "审批重新发行申请"
          : "审批身份识别码"
    );
    const detail = byId("identity-review-detail");
    detail.replaceChildren();
    for (const [label, value] of [
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
    ]) {
      detail.append(create("dt", "", label), create("dd", "", value));
    }
    byId("identity-review-expiry").value = identityExpiryDate();
    byId("identity-review-permanent").checked = false;
    byId("identity-rejection-reason").value = "";
    setText("identity-review-feedback", "");
    byId("identity-review-dialog").showModal();
  }

  async function reviewIdentity(action) {
    const item = state.selectedIdentityApplication;
    if (!item) return;
    const feedback = byId("identity-review-feedback");
    feedback.textContent = "正在处理并发送邮件…";
    try {
      const body =
        action === "approve"
          ? {
              permanent: byId("identity-review-permanent").checked,
              expiresOn: byId("identity-review-permanent").checked
                ? null
                : byId("identity-review-expiry").value
            }
          : { reason: byId("identity-rejection-reason").value.trim() };
      const result = await request(
        `/api/admin/identity-applications/${encodeURIComponent(item.id)}/${action}`,
        { method: "POST", body: JSON.stringify(body) }
      );
      byId("identity-review-dialog").close();
      byId("save-state").textContent =
        result.emailSent
          ? action === "approve"
            ? "申请已通过并发送邮件"
            : "申请已拒绝并发送通知"
          : `申请已处理，但邮件发送失败：${result.emailError}`;
      await loadIdentityApplications();
      await loadIdentityCodes();
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

  function renderIdentityCodes() {
    const payload = state.identityCodes;
    const pages = Math.max(1, Math.ceil(payload.total / 10));
    const root = byId("identity-code-table");
    root.replaceChildren();
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
      await request(`/api/admin/identity-codes/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        body: JSON.stringify(values)
      });
      await loadIdentityCodes();
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
    const value = window.prompt(
      window.MrzhI18n.t(
        "更换会立即作废旧识别码。请输入更换后识别码的有效日期（YYYY-MM-DD），或输入 permanent 设置为永久有效："
      ),
      item.expires_at ? identityExpiryDate(item.expires_at) : ""
    );
    if (!value) return;
    if (
      !window.confirm(
        window.MrzhI18n.t(
          "确认作废旧识别码、生成更换后的识别码并发送识别码信息邮件？"
        )
      )
    ) {
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
  window.addEventListener("beforeunload", (event) => {
    if (!state.dirtySections.size) return;
    event.preventDefault();
    event.returnValue = "";
  });
  byId("admin-member-search").addEventListener("input", (event) => {
    state.memberQuery = event.target.value || "";
    renderAdminMembers(state.bootstrap?.members || []);
  });
  byId("technology-search").addEventListener("input", (event) => {
    state.technologyQuery = event.target.value || "";
    renderTechnologyEditor();
  });
  byId("technology-category-filter").addEventListener("change", (event) => {
    state.technologyCategory = event.target.value || "all";
    renderTechnologyEditor();
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
  window.addEventListener("resize", closeRunActionMenu);
  window.addEventListener("scroll", closeRunActionMenu, true);
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
    refresh(false);
  });
  setDefaultKeyExpiry();
  input("identityExpiresAt").value = identityExpiryDate();
  refresh(true);
  setInterval(() => refresh(false), 10_000);
})();
