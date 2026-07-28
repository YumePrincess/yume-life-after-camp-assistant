(() => {
  "use strict";

  const TASKS = [
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
  const TASK_NAMES = {
    ...Object.fromEntries(TASKS.map(([key, name]) => [key, name])),
    member_sync: "成员同步",
    automation_routine: "任务例程",
    kick_member: "踢出成员",
    kick_inactive_members: "自动斩杀"
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
    activeView: "overview",
    accessAllowed: false
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
    return TASK_NAMES[value] || value;
  }

  function hasPermission(permission) {
    const permissions = state.bootstrap?.session?.permissions || [];
    return permissions.includes("*") || permissions.includes(permission);
  }

  function stateName(value) {
    return {
      queued: "排队",
      claimed: "已领取",
      running: "执行中",
      cancelling: "中断中",
      interrupted: "已中断",
      succeeded: "成功",
      failed: "失败",
      skipped: "已跳过"
    }[value] || value;
  }

  function formatDate(value) {
    if (!value) return "—";
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(new Date(value));
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
    for (const [key, name, copy] of TASKS) {
      const card = create("article", "task-card");
      const button = create("button", "button button-primary", "立即执行");
      button.type = "button";
      button.disabled = !hasPermission("task:run");
      button.addEventListener("click", () => runTask(key, button));
      card.append(create("h3", "", name), create("p", "", copy), button);
      root.append(card);
    }
  }

  function renderAgents(heartbeats) {
    const root = byId("agent-status");
    root.replaceChildren();
    if (!heartbeats?.length) {
      root.append(create("p", "empty-state", "尚未收到本地 Agent 心跳。"));
      return;
    }
    for (const item of heartbeats) {
      const age = Date.now() - Date.parse(item.updated_at);
      const online =
        age < (state.bootstrap?.agentOnlineThresholdSeconds || 45) * 1000;
      const card = create("article", "agent-card");
      card.append(
        create(
          "strong",
          "",
          window.MrzhI18n.format("{agent} · {state}", {
            agent: item.agent_id,
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
        )
      );
      root.append(card);
    }
  }

  function fillConfig(bundle, sections = CONFIG_SECTIONS) {
    const camp = bundle.campConfig;
    const overview = bundle.publicOverview;
    const automation = bundle.automationConfig;
    const tasks = automation.tasks;
    if (sections.includes("general")) {
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
        automaticKickEnabled: camp.automaticKickEnabled,
        automaticKickGraceDays: camp.automaticKickGraceDays,
        temporaryKeyLoginEnabled: bundle.authConfig.temporaryKeyLoginEnabled,
        announcement: overview.announcement,
        highlights: (overview.highlights || []).join("\n")
      })) {
        setField(name, value);
      }
    }
    if (sections.includes("tasks")) {
      for (const [name, value] of Object.entries({
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
    }
    if (sections.includes("agent")) {
      for (const [name, value] of Object.entries({
        pollActiveSeconds: automation.agentPolling.activeSeconds,
        pollIdleSeconds: automation.agentPolling.idleSeconds,
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
    for (const option of summary.options || []) {
      root.append(
        create(
          "span",
          "vote-summary-item",
          window.MrzhI18n.format("{name} · {votes} 票", {
            name: option.name,
            votes: option.votes
          })
        )
      );
    }
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
      new Date().toISOString().slice(0, 10);
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

    const root = byId("technology-catalog-grid");
    root.replaceChildren();
    byId("technology-empty").hidden = Boolean(config.catalog.length);
    for (const item of [...config.catalog].sort(
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
    const root = byId("run-table");
    root.replaceChildren();
    for (const run of runs || []) {
      const row = document.createElement("tr");
      row.append(
        create("td", "", taskName(run.task_key)),
        create("td", `status-${run.state}`, stateName(run.state)),
        create("td", "numeric", `${Math.round((run.progress || 0) * 100)}%`),
        create("td", "", run.message || "—"),
        create("td", "", formatDate(run.finished_at || run.created_at))
      );
      const actions = create("td");
      const detail = create("button", "button button-quiet", "事件");
      detail.type = "button";
      detail.addEventListener("click", () => showEvents(run.id));
      actions.append(detail);
      if (ACTIVE_STATES.has(run.state)) {
        const cancellationPending = run.state === "cancelling";
        const cancel = create(
          "button",
          "button button-danger",
          cancellationPending
            ? "终止已提交"
            : run.state === "queued"
              ? "取消排队"
              : "终止任务"
        );
        cancel.type = "button";
        cancel.disabled =
          cancellationPending || !hasPermission("task:interrupt");
        cancel.addEventListener("click", () => interruptRun(run.id, cancel));
        actions.append(cancel);
      }
      row.append(actions);
      root.append(row);
    }
  }

  function activateView(view) {
    const availableViews = new Set(
      [...document.querySelectorAll("[data-admin-view]")].map(
        (element) => element.dataset.adminView
      )
    );
    const resolved =
      availableViews.has(view) && (view !== "access" || state.accessAllowed)
        ? view
        : "overview";
    state.activeView = resolved;
    for (const element of document.querySelectorAll("[data-admin-view]")) {
      element.hidden =
        element.dataset.adminView !== resolved ||
        (element.dataset.adminView === "access" && !state.accessAllowed);
    }
    for (const link of document.querySelectorAll("[data-nav-target]")) {
      const active = link.dataset.navTarget === resolved;
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
  }

  function render(data, fillSections = []) {
    state.bootstrap = data;
    state.csrfToken = data.session.csrfToken;
    renderTaskActions();
    byId("session-email").textContent =
      data.session.displayName || data.session.email;
    document.body.dataset.readonly = String(
      !hasPermission("config:write") &&
        !hasPermission("task:run") &&
        !hasPermission("task:interrupt") &&
        !hasPermission("member:kick") &&
        !hasPermission("keys:manage")
    );
    byId("next-tech-date").textContent = data.nextTechnologyTargetDate || "--";
    renderAgents(data.heartbeats);
    renderVote(data.voteSummary);
    renderRuns(data.recentRuns);
    renderAdminMembers(data.members || []);
    renderAutoKick(data.autoKickCandidates || [], data.configBundle.campConfig);
    renderTemporaryKeys(data.temporaryKeys || []);
    state.accessAllowed = hasPermission("keys:manage");
    document.querySelector('[data-nav-target="access"]').hidden =
      !state.accessAllowed;
    if (fillSections.length) {
      fillConfig(data.configBundle, fillSections);
    }
    setConfigReadOnly(!hasPermission("config:write"));
    if (!hasPermission("member:kick")) {
      input("automaticKickEnabled").disabled = true;
      input("automaticKickGraceDays").disabled = true;
    }
    const requestedView = location.hash.slice(1) || state.activeView;
    activateView(requestedView);
  }

  function setConfigReadOnly(readonly) {
    for (const field of document.querySelectorAll(
      ".config-form input, .config-form select, .config-form textarea, .config-form button"
    )) {
      field.disabled = readonly || (state.saving && field.matches('button[type="submit"]'));
    }
  }

  function renderTemporaryKeys(items) {
    const root = byId("temporary-key-list");
    if (!root) return;
    root.replaceChildren();
    if (!items.length) {
      root.append(create("p", "empty-state", "尚未生成临时 Key。"));
      return;
    }
    for (const item of items) {
      let permissions = [];
      try {
        permissions = JSON.parse(item.permissions_json || "[]");
      } catch {
        permissions = [];
      }
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
        permissions.length ? permissions.join(" · ") : window.MrzhI18n.t("仅预览"),
        window.MrzhI18n.format("有效期 {date}", {
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
      const revoke = create("button", "button button-danger", "撤销");
      revoke.type = "button";
      revoke.disabled = Boolean(item.revoked_at);
      revoke.addEventListener("click", () => revokeTemporaryKey(item.id, revoke));
      row.append(identity, create("div", "key-item-meta", suffix), revoke);
      root.append(row);
    }
  }

  function renderAdminMembers(items) {
    const query = state.memberQuery.toLowerCase();
    const filtered = items.filter((item) =>
      [
        item.name,
        item.profession,
        item.roommate_name,
        item.camp_title,
        item.last_active_text
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
        item.material_contribution ?? 0,
        item.last_active_text || "—"
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
      ["在线情况", member.last_active_text],
      ["离线折算天数", member.inactive_days],
      ["活跃采集时间", formatDate(member.activity_captured_at)],
      ["资料采集时间", formatDate(member.last_seen_at)]
    ]) {
      detail.append(create("dt", "", label), create("dd", "", String(value ?? "—")));
    }
    byId("kick-member").disabled = !hasPermission("member:kick");
    byId("member-dialog").showModal();
  }

  function renderAutoKick(candidates, camp) {
    const threshold =
      Number(camp.inactivityWarningDays || 0) +
      Number(camp.automaticKickGraceDays || 0);
    byId("auto-kick-summary").textContent = camp.automaticKickEnabled
      ? window.MrzhI18n.format(
          "已开启：离线达到 {threshold} 天时按最新识别名单处理；当前候选 {count} 人。",
          { threshold, count: candidates.length }
        )
      : window.MrzhI18n.format(
          "默认关闭。若开启，判定线为预警 {warning} 天＋宽限 {grace} 天。",
          {
            warning: camp.inactivityWarningDays,
            grace: camp.automaticKickGraceDays
          }
        );
    byId("auto-kick-evaluate").disabled =
      !camp.automaticKickEnabled || !candidates.length || !hasPermission("member:kick");
  }

  async function kickSelectedMember() {
    const member = state.selectedMember;
    if (!member) return;
    const confirmation = window.prompt(
      window.MrzhI18n.format(
        "高风险操作：将从市政厅沙盘踢出“{name}”。请输入完整成员姓名确认：",
        { name: member.name }
      )
    );
    if (confirmation !== member.name) {
      byId("save-state").textContent = "姓名不一致，已取消踢出";
      return;
    }
    try {
      await request("/api/admin/kick-member", {
        method: "POST",
        body: JSON.stringify({
          memberName: member.name,
          confirmMemberName: confirmation
        })
      });
      byId("member-dialog").close();
      byId("save-state").textContent = window.MrzhI18n.format(
        "踢出 {name} 的任务已入队",
        { name: member.name }
      );
      await refresh(false);
    } catch (error) {
      byId("save-state").textContent = error.message;
    }
  }

  async function evaluateAutoKick() {
    if (
      !window.confirm(
        "将依据最新在线情况，把当前达到“预警天数＋宽限天数”的精确名单加入踢出任务。继续吗？"
      )
    ) {
      return;
    }
    try {
      const result = await request("/api/admin/auto-kick-evaluate", {
        method: "POST",
        body: "{}"
      });
      byId("save-state").textContent = result.run
        ? window.MrzhI18n.format("自动斩杀任务已入队，共 {count} 人", {
            count: result.candidates.length
          })
        : window.MrzhI18n.t("当前没有达到斩杀线的成员");
      await refresh(false);
    } catch (error) {
      byId("save-state").textContent = error.message;
    }
  }

  async function refresh(forceAll = false) {
    if (state.refreshing || state.saving) return;
    state.refreshing = true;
    try {
      const data = await request(`/api/admin/bootstrap?t=${Date.now()}`);
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
        body: JSON.stringify({ taskKey, ...(routineId ? { routineId } : {}) })
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
    const root = byId("run-events");
    root.replaceChildren(create("p", "empty-state", "正在加载…"));
    byId("run-dialog").showModal();
    try {
      const payload = await request(`/api/admin/runs/${encodeURIComponent(runId)}/events`);
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
      root.replaceChildren(create("p", "error-text", error.message));
    }
  }

  function collectConfig(section) {
    const next = JSON.parse(
      JSON.stringify(state.bootstrap.configBundle)
    );
    if (section === "general") {
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
        inactivityWarningDays: Number(getField("inactivityWarningDays")),
        automaticKickEnabled: getField("automaticKickEnabled"),
        automaticKickGraceDays: Number(getField("automaticKickGraceDays"))
      };
      next.authConfig = {
        temporaryKeyLoginEnabled: getField("temporaryKeyLoginEnabled")
      };
      next.publicOverview = {
        announcement: String(getField("announcement")).trim(),
        highlights: String(getField("highlights"))
          .split("\n")
          .map((value) => value.trim())
          .filter(Boolean)
      };
      next.automationConfig.timezone = timezone;
    } else if (section === "tasks") {
      next.automationConfig.tasks = {
        tech_switch: {
          enabled: getField("techEnabled"),
          time: getField("techTime")
        },
        contribution_sync: {
          enabled: getField("contributionEnabled"),
          time: getField("contributionTime")
        },
        inactivity_sync: {
          enabled: getField("inactivityEnabled"),
          time: getField("inactivityTime")
        },
        member_profile_sync: {
          enabled: getField("profileEnabled"),
          time: getField("profileTime")
        },
        patrol: {
          enabled: getField("patrolEnabled"),
          time: getField("patrolTime"),
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
      for (const button of buttons) {
        button.disabled = !hasPermission("config:write");
      }
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
    try {
      const payload = await request("/api/admin/temp-keys", {
        method: "POST",
        body: JSON.stringify({
          name: form.elements.keyName.value.trim(),
          expiresAt: new Date(form.elements.keyExpiresAt.value).toISOString(),
          permissions
        })
      });
      byId("temporary-key-value").textContent = payload.key;
      byId("temporary-key-reveal").hidden = false;
      form.reset();
      setDefaultKeyExpiry();
      await refresh(false);
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
      await refresh(false);
    } catch (error) {
      byId("save-state").textContent = error.message;
      button.disabled = false;
    }
  }

  function setDefaultKeyExpiry() {
    const field = input("keyExpiresAt");
    if (!field || field.value) return;
    const date = new Date(Date.now() + 24 * 60 * 60_000);
    field.value = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16);
  }

  renderTaskActions();
  for (const form of document.querySelectorAll(".config-form")) {
    form.addEventListener("input", () => {
      const section = form.dataset.configSection;
      state.dirtySections.add(section);
      form.querySelector("[data-save-feedback]").textContent = "有未保存修改";
      updateSaveState();
    });
    form.addEventListener("submit", saveConfig);
  }
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
  byId("kick-member").addEventListener("click", kickSelectedMember);
  byId("auto-kick-evaluate").addEventListener("click", evaluateAutoKick);
  byId("refresh-admin").addEventListener("click", () => refresh(false));
  byId("logout").addEventListener("click", logout);
  byId("temporary-key-form").addEventListener("submit", generateTemporaryKey);
  byId("copy-temporary-key").addEventListener("click", async () => {
    await navigator.clipboard.writeText(byId("temporary-key-value").textContent);
    byId("save-state").textContent = "临时 Key 已复制";
  });
  document.addEventListener("mrzh:languagechange", () => {
    if (state.bootstrap) render(state.bootstrap, []);
  });
  setDefaultKeyExpiry();
  refresh(true);
  setInterval(() => refresh(false), 10_000);
})();
