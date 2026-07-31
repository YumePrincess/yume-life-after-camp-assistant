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
  const VIEW_PERMISSIONS = {
    overview: "admin:overview",
    general: "admin:general",
    tasks: "admin:tasks",
    agent: "admin:agent",
    technology: "admin:technology",
    "identity-applications": "admin:identity-review",
    "identity-codes": "admin:identity-codes",
    smtp: "admin:smtp",
    access: "admin:access",
    members: "admin:members",
    history: "admin:history"
  };
  const PERMISSION_ALIASES = {
    "admin:overview": ["task:run"],
    "admin:general": ["config:write"],
    "admin:tasks": ["config:write"],
    "admin:agent": ["config:write"],
    "admin:technology": ["config:write"],
    "admin:identity-review": ["identity:review"],
    "admin:identity-codes": ["identity:manage"],
    "admin:smtp": ["smtp:manage"],
    "admin:access": ["keys:manage"],
    "admin:members": ["member:kick"],
    "admin:history": ["task:interrupt"],
    "task:run": ["admin:overview"],
    "task:interrupt": ["admin:history"],
    "member:kick": ["admin:members"],
    "keys:manage": ["admin:access"],
    "identity:review": ["admin:identity-review"],
    "identity:manage": ["admin:identity-codes"],
    "smtp:manage": ["admin:smtp"]
  };
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
    technologyQuery: "",
    technologyCategory: "all",
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
    selectedIdentityApplication: null,
    publicContentLocale: "zh-cn",
    publicContentDraft: null,
    smtpConfigLoaded: false,
    smtpConfigLoading: false,
    smtpDraftRevision: 0,
    smtpDirty: false
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
    return TASK_NAMES[value] || value;
  }

  function permissionName(value) {
    return (
      {
        "demo:preview": "Demo · 全后台只读",
        "admin:overview": "控制台",
        "admin:general": "基础设置",
        "admin:tasks": "任务计划",
        "admin:agent": "执行策略",
        "admin:technology": "科技管理",
        "admin:identity-review": "识别码审批",
        "admin:identity-codes": "身份识别码",
        "admin:smtp": "SMTP 发信",
        "admin:access": "访问密钥",
        "admin:members": "成员管理",
        "admin:history": "运行记录",
        "config:write": "修改配置",
        "task:run": "执行任务",
        "task:interrupt": "中断任务",
        "member:kick": "踢出成员",
        "keys:manage": "管理 Key",
        "identity:review": "审批身份识别码",
        "identity:manage": "管理身份识别码",
        "smtp:manage": "管理 SMTP 配置"
      }[value] || value
    );
  }

  function hasPermission(permission) {
    const permissions = state.bootstrap?.session?.permissions || [];
    return (
      permissions.includes("*") ||
      permissions.includes(permission) ||
      (PERMISSION_ALIASES[permission] || []).some((alias) =>
        permissions.includes(alias)
      )
    );
  }

  function canView(view) {
    const permissions = state.bootstrap?.session?.permissions || [];
    return (
      permissions.includes("*") ||
      permissions.includes("demo:preview") ||
      hasPermission(VIEW_PERMISSIONS[view])
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
        automaticKickEnabled: camp.automaticKickEnabled,
        automaticKickGraceDays: camp.automaticKickGraceDays,
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

  function openVoteDetails(option, ballots) {
    byId("vote-detail-title").textContent = option.name;
    byId("vote-detail-summary").textContent =
      `共 ${ballots.length} 票；同一识别码重复投票时仅保留最后一次提交。`;
    const root = byId("vote-detail-list");
    root.replaceChildren();
    if (!ballots.length) {
      root.append(create("p", "empty-state", "暂无投票记录"));
    } else {
      for (const ballot of ballots) {
        const item = create("article", "vote-detail-item");
        const identity = create("code", "vote-detail-code", ballot.identityCode || "—");
        const player = create("strong", "vote-detail-player", ballot.playerName || "—");
        const time = create("time", "muted", formatDate(ballot.votedAt));
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
  }

  function render(data, fillSections = []) {
    state.bootstrap = data;
    document.documentElement.dataset.timezone =
      data.configBundle?.campConfig?.timezone || "Asia/Shanghai";
    state.csrfToken = data.session.csrfToken;
    renderTaskActions();
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
      renderAutoKick(data.autoKickCandidates || [], data.configBundle.campConfig);
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
    if (!hasPermission("member:kick")) {
      input("automaticKickEnabled").disabled = true;
      input("automaticKickGraceDays").disabled = true;
    }
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
        field.disabled =
          readonly ||
          (state.saving && field.matches('button[type="submit"]'));
      }
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
    byId("kick-member").disabled = !hasPermission("member:kick");
    byId("auto-kick-evaluate").disabled = !hasPermission("member:kick");
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
        const revoke = create("button", "button button-danger", "撤销");
        revoke.type = "button";
        revoke.hidden = !hasPermission("keys:manage");
        revoke.disabled = Boolean(item.revoked_at);
        revoke.addEventListener("click", () => revokeTemporaryKey(item.id, revoke));
        row.append(identity, create("div", "key-item-meta", suffix), revoke);
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
        inactivityWarningDays: Number(getField("inactivityWarningDays")),
        automaticKickEnabled: getField("automaticKickEnabled"),
        automaticKickGraceDays: Number(getField("automaticKickGraceDays"))
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
        item.code,
        item.player_name || "—",
        item.email || "—",
        item.status === "disabled" ? "取消" : expired ? "已过期" : "有效",
        item.expires_at ? formatDate(item.expires_at) : "永久有效",
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
            label: item.status === "active" ? "取消" : "恢复",
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
            label: "重新发行识别码",
            icon: "events",
            disabled: !item.email || !item.player_name,
            onSelect: () => reissueIdentity(item)
          },
          {
            label: "重新发送",
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

  async function editIdentityInformation(item) {
    const playerName = window.prompt(
      window.MrzhI18n.t("输入玩家名称："),
      item.player_name || ""
    );
    if (playerName === null) return;
    const email = window.prompt(
      window.MrzhI18n.t("输入接收邮箱："),
      item.email || ""
    );
    if (email === null) return;
    const locale = window.prompt(
      window.MrzhI18n.t("输入邮件语言（zh-cn、zh-tw、en、fr、ja）："),
      item.locale || "zh-cn"
    );
    if (locale === null) return;
    const expiresOn = window.prompt(
      window.MrzhI18n.t("输入有效日期（YYYY-MM-DD），或输入 permanent 设置为永久有效："),
      item.expires_at ? identityExpiryDate(item.expires_at) : "permanent"
    );
    if (expiresOn === null) return;
    const permanent = expiresOn.trim().toLowerCase() === "permanent";
    try {
      await request(
        `/api/admin/identity-codes/${encodeURIComponent(item.id)}/information`,
        {
          method: "PATCH",
          body: JSON.stringify({
            playerName: playerName.trim(),
            email: email.trim(),
            locale: locale.trim().toLowerCase(),
            permanent,
            expiresOn: permanent ? null : expiresOn.trim()
          })
        }
      );
      byId("save-state").textContent = window.MrzhI18n.t("识别码资料已修改");
      await loadIdentityCodes();
      await loadIdentityApplications();
    } catch (error) {
      byId("save-state").textContent = error.message;
    }
  }

  async function reissueIdentity(item) {
    const value = window.prompt(
      "重新发行会立即作废旧识别码。请输入新识别码的有效日期（YYYY-MM-DD），或输入 permanent 设置为永久有效：",
      item.expires_at ? identityExpiryDate(item.expires_at) : ""
    );
    if (!value) return;
    if (!window.confirm("确认作废旧识别码、生成新识别码并发送邮件？")) return;
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
        ? "新识别码已发行并发送邮件"
        : `新识别码已发行，但邮件发送失败：${result.emailError}`;
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
      byId("save-state").textContent = "识别码邮件已重新发送";
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
  byId("public-content-locale").addEventListener("change", (event) => {
    switchPublicContentLocale(event.target.value);
  });
  byId("kick-member").addEventListener("click", kickSelectedMember);
  byId("auto-kick-evaluate").addEventListener("click", evaluateAutoKick);
  byId("refresh-admin").addEventListener("click", () => refresh(false));
  byId("logout").addEventListener("click", logout);
  byId("temporary-key-form").addEventListener("submit", generateTemporaryKey);
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
  byId("run-dialog").addEventListener("close", stopEventRefresh);
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
