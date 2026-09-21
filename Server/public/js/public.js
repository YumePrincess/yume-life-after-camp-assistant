(() => {
  "use strict";

  const state = {
    data: null,
    selections: new Set(),
    memberQuery: "",
    identityMode: "new",
    renewalCode: "",
    renewalApplicationNumber: "",
    reissueCode: "",
    reissueApplicationNumber: "",
    reissueEmail: "",
    reissuePlayerName: "",
    voteErrorRenewalCode: "",
    activeFeature: "",
    dailyPanel: "",
    dailyIdentityCodes: {},
    dailySelections: {},
    identityCodeEdited: false,
    liveSocket: null,
    liveReconnectTimer: null,
    liveReconnectAttempt: 0,
    liveRefreshInFlight: false,
    liveRefreshQueued: false,
    liveDirty: false
  };
  const FEATURE_IDS = ["overview", "staff", "warnings", "vote", "members", "runs"];
  const IDENTITY_CODE_STORAGE_KEY = "mrzh.identity-code";
  const ACTIVE_IDENTITY_CONFLICT =
    "您提供的信息可能已经成功申请身份识别码。如果您忘记了身份识别码，请通过“忘记识别码”功能找回。如果这不是您提交的申请，请联系市长处理。";
  const EXPIRED_IDENTITY_CONFLICT =
    "您提供的信息关联的身份识别码已过期，请通过“申请延长识别码有效期”功能申请延期。延期申请被拒绝后，该识别码将标记为失效，届时可以重新申请身份识别码。";

  function byId(id) {
    return document.getElementById(id);
  }

  function dailyVoteFeatureCount(payload) {
    return (Array.isArray(payload?.items) ? payload.items.length : 0) + 1;
  }

  function rememberedIdentityCode() {
    try {
      const value = window.localStorage.getItem(IDENTITY_CODE_STORAGE_KEY) || "";
      return /^\d{8}$/.test(value) ? value : "";
    } catch {
      return "";
    }
  }

  function syncRememberedIdentityCodeInputs(code, { force = false } = {}) {
    if (!/^\d{8}$/.test(code)) return;
    const identityInput = byId("identity-code");
    if (identityInput && (force || (!state.identityCodeEdited && !identityInput.value.trim()))) {
      identityInput.value = code;
    }
    for (const input of document.querySelectorAll(".daily-identity-code")) {
      const itemId = input.dataset.dailyItemId;
      const hasState = itemId && Object.prototype.hasOwnProperty.call(state.dailyIdentityCodes, itemId);
      if (force || (!hasState && !input.value.trim())) {
        input.value = code;
        if (itemId) state.dailyIdentityCodes[itemId] = code;
      }
    }
  }

  function hydrateRememberedIdentityCodeInputs() {
    syncRememberedIdentityCodeInputs(rememberedIdentityCode());
  }

  function rememberIdentityCode(value) {
    const code = String(value || "").trim();
    if (!/^\d{8}$/.test(code)) return;
    try {
      window.localStorage.setItem(IDENTITY_CODE_STORAGE_KEY, code);
    } catch {
      // Private browsing or an embedded webview may deny localStorage access.
    }
    state.identityCodeEdited = false;
    syncRememberedIdentityCodeInputs(code, { force: true });
  }

  function syncDailyFeatureBackButton() {
    const button = byId("back-daily-vote");
    if (!button) return;
    button.hidden = state.activeFeature !== "vote" || !state.dailyPanel;
  }

  function resetFeatureSelection({ clearHash = true, restoreFocus = false } = {}) {
    const activeId = state.activeFeature;
    const activeCard = activeId
      ? document.querySelector(`.feature-card[data-feature-target="${activeId}"]`)
      : null;
    for (const panelId of FEATURE_IDS) {
      const item = byId(panelId);
      if (item) item.hidden = true;
    }
    for (const card of document.querySelectorAll(".feature-card[data-feature-target]")) {
      card.classList.remove("is-active");
      card.setAttribute("aria-expanded", "false");
    }
    state.activeFeature = "";
    state.dailyPanel = "";
    syncDailyFeatureBackButton();
    if (clearHash) {
      history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
    if (restoreFocus && activeCard && !activeCard.hidden) activeCard.focus();
  }

  function showFeature(id, { updateHash = true } = {}) {
    if (!FEATURE_IDS.includes(id)) return false;
    const panel = byId(id);
    const selectedCard = document.querySelector(
      `.feature-card[data-feature-target="${id}"]`
    );
    const dialog = byId("feature-detail-dialog");
    if (!panel || !selectedCard || selectedCard.hidden || !dialog) return false;
    if (id !== "vote") state.dailyPanel = "";
    for (const panelId of FEATURE_IDS) {
      const item = byId(panelId);
      if (item) item.hidden = panelId !== id;
    }
    for (const card of document.querySelectorAll(".feature-card[data-feature-target]")) {
      const active = card.dataset.featureTarget === id;
      card.classList.toggle("is-active", active);
      card.setAttribute("aria-expanded", String(active));
    }
    state.activeFeature = id;
    syncDailyFeatureBackButton();
    setText(
      "feature-detail-title",
      selectedCard?.querySelector(".feature-card-copy strong")?.textContent || ""
    );
    if (updateHash) {
      history.replaceState(null, "", `#${id}`);
    }
    if (!dialog.open) dialog.showModal();
    return true;
  }

  function handleFeatureNavigation(event) {
    const control = event.currentTarget;
    const id = control.dataset.featureTarget;
    if (!id) return;
    event.preventDefault();
    showFeature(id);
  }

  function initFeatureNavigation() {
    for (const control of document.querySelectorAll("[data-feature-target]")) {
      control.addEventListener("click", handleFeatureNavigation);
    }
    window.addEventListener("hashchange", () => {
      const id = window.location.hash.slice(1);
      if (FEATURE_IDS.includes(id)) showFeature(id, { updateHash: false });
    });
    byId("close-feature-detail").addEventListener("click", () => {
      byId("feature-detail-dialog").close();
    });
    byId("back-daily-vote").addEventListener("click", backDailyPanels);
    byId("feature-detail-dialog").addEventListener("click", (event) => {
      if (event.target === event.currentTarget) event.currentTarget.close();
    });
    byId("feature-detail-dialog").addEventListener("close", () => {
      resetFeatureSelection({ restoreFocus: true });
    });
    resetFeatureSelection();
  }

  function setText(id, value) {
    const element = byId(id);
    if (element) element.textContent = value ?? "";
  }

  function create(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) {
      element.textContent = window.MrzhI18n?.t
        ? window.MrzhI18n.t(text)
        : text;
    }
    return element;
  }

  function identityExpiryLabel(value) {
    const expiry = value
      ? new Intl.DateTimeFormat(window.MrzhI18n.language(), {
          timeZone: configuredTimezone(),
          dateStyle: "long",
          timeStyle: "short"
        }).format(new Date(value))
      : window.MrzhI18n.t("永久有效");
    return window.MrzhI18n.format("识别码有效期：{date}", { date: expiry });
  }

  function identityRenewalNoticeKey(value) {
    if (!value) return "";
    const expiryTime = new Date(value).getTime();
    if (!Number.isFinite(expiryTime)) return "";
    const remaining = expiryTime - Date.now();
    if (remaining > 7 * 24 * 60 * 60 * 1000) return "";
    return remaining <= 0
      ? "识别码已过期，请申请延期；延期审批期间，过期识别码可额外投票一次。"
      : "识别码将在 7 天内到期，请及时申请延期；延期审批期间，过期识别码可额外投票一次。";
  }

  function showVoteSuccessDialog({ kind, data, message }) {
    const isTest = Boolean(data?.publicTestVote);
    const renewalNoticeKey = isTest
      ? ""
      : identityRenewalNoticeKey(data?.identityCodeExpiresAt);
    setText(
      "vote-success-kicker",
      kind === "daily" ? "DAILY VOTING" : "TECHNOLOGY VOTE"
    );
    setText("vote-success-message", message);
    setText(
      "vote-success-expiry",
      isTest ? "" : identityExpiryLabel(data?.identityCodeExpiresAt)
    );
    setText(
      "vote-success-renewal",
      renewalNoticeKey ? window.MrzhI18n.t(renewalNoticeKey) : ""
    );
    const renewal = byId("vote-success-renewal");
    if (renewal) renewal.hidden = isTest;
    const dialog = byId("vote-success-dialog");
    if (dialog && !dialog.open) dialog.showModal();
  }

  async function request(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(payload.error || payload.title || `HTTP ${response.status}`);
      Object.assign(error, payload, { status: response.status });
      throw error;
    }
    return payload;
  }

  function categoryName(value) {
    const source = { military: "军事", agriculture: "农业", industry: "工业" }[value];
    return source ? window.MrzhI18n.t(source) : value;
  }

  function laneName(value) {
    return window.MrzhI18n.t(
      value === "core" ? "类型科技（第一行）" : "通用科技（第二行）"
    );
  }

  function taskName(value) {
    const source = {
      tech_switch: "更新科技",
      contribution_sync: "更新贡献",
      inactivity_sync: "更新斩杀预警",
      member_profile_sync: "更新成员资料",
      member_sync: "成员同步",
      patrol: "营地巡逻"
    }[value];
    return source ? window.MrzhI18n.t(source) : value;
  }

  function pluginEnabled(id) {
    return (state.data?.plugins || []).some(
      (plugin) => plugin.id === id && plugin.enabled
    );
  }

  function applyPluginVisibility() {
    const sections = {
      inactivity: ["warnings"],
      "member-profile": ["members", "staff"]
    };
    for (const [pluginId, ids] of Object.entries(sections)) {
      const enabled = pluginEnabled(pluginId);
      for (const id of ids) {
        const section = byId(id);
        if (section && !enabled) section.hidden = true;
        for (const link of document.querySelectorAll(
          `[href="#${id}"], [data-feature-target="${id}"]`
        )) {
          link.hidden = !enabled;
        }
      }
    }
  }

  function stateName(value) {
    const source = {
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
    }[value];
    return source ? window.MrzhI18n.t(source) : value;
  }

  function optionMap(summary) {
    return new Map((summary.options || []).map((option) => [option.key, option]));
  }

  function requiredVoteKeys(summary, key, result = new Set(), visiting = new Set()) {
    if (result.has(key) || visiting.has(key)) return result;
    const option = optionMap(summary).get(key);
    if (!option) return result;
    visiting.add(key);
    if (option.prerequisiteKey) {
      requiredVoteKeys(summary, option.prerequisiteKey, result, visiting);
    }
    visiting.delete(key);
    result.add(key);
    return result;
  }

  function configuredVoteLimit(summary) {
    const value = Number(summary?.voteLimit);
    return Number.isInteger(value) && value >= 0 && value <= 12 ? value : 6;
  }

  function removeVoteAndDependents(summary, key) {
    const before = state.selections.size;
    state.selections.delete(key);
    let changed = true;
    while (changed) {
      changed = false;
      for (const option of summary.options || []) {
        if (
          state.selections.has(option.key) &&
          option.prerequisiteKey &&
          !state.selections.has(option.prerequisiteKey) &&
          optionMap(summary).has(option.prerequisiteKey)
        ) {
          state.selections.delete(option.key);
          changed = true;
        }
      }
    }
    return before - state.selections.size;
  }

  function toggleVote(summary, option) {
    const feedback = byId("vote-feedback");
    if (state.selections.has(option.key)) {
      const removed = removeVoteAndDependents(summary, option.key);
      feedback.textContent =
        removed > 1
          ? window.MrzhI18n.t(
              "取消前置科技时，依赖它的科技也会一并取消。"
            )
          : "";
      renderVote(summary);
      return;
    }
    const required = requiredVoteKeys(summary, option.key);
    const additions = [...required].filter((key) => !state.selections.has(key));
    const voteLimit = configuredVoteLimit(summary);
    if (state.selections.size + additions.length > voteLimit) {
      feedback.textContent = window.MrzhI18n.format(
        "选择该科技及其前置科技后将超过 {limit} 票。",
        { limit: voteLimit }
      );
      return;
    }
    for (const key of additions) state.selections.add(key);
    feedback.textContent = option.prerequisiteName
      ? window.MrzhI18n.format(
          "已同时选择前置科技：{name}",
          { name: option.prerequisiteName }
        )
      : "";
    renderVote(summary);
  }

  function renderVote(summary) {
    setText("poll-date", summary.pollDate || "--");
    setText(
      "vote-deadline",
      window.MrzhI18n.format("开放时间 {opensAt}–{closesAt} {timezone} · 共 {count} 人投票", {
        count: summary.ballotCount || 0,
        opensAt: summary.opensAt || "--",
        closesAt: summary.closesAt || "--",
        timezone: summary.timezone || ""
      })
    );
    const voteLimit = configuredVoteLimit(summary);
    setText(
      "vote-limit-description",
      window.MrzhI18n.format(
        "每人最多可投票 {limit} 票，多次投票以最新一次投票结果为准，不选择科技提交投票可以撤回投票或投空票。",
        { limit: voteLimit }
      )
    );
    const voteWindowState = byId("vote-window-state");
    if (voteWindowState) {
      voteWindowState.classList.toggle("is-open", summary.isOpen !== false);
      voteWindowState.textContent = window.MrzhI18n.t(
        summary.isOpen === false ? "当前未开放" : "当前可投票"
      );
    }
    const root = byId("vote-options");
    root.replaceChildren();
    renderVoteSelection(summary);
    byId("submit-vote").disabled =
      summary.isOpen === false || !summary.options?.length;
    const identityInput = byId("identity-code");
    if (identityInput) identityInput.disabled = summary.isOpen === false;
    if (!summary.options?.length) {
      root.append(create("p", "empty-state", "管理员尚未开放科技投票。"));
      return;
    }
    for (const lane of ["core", "general"]) {
      const options = summary.options.filter((option) => option.lane === lane);
      if (!options.length) continue;
      const section = create("section", "vote-lane");
      section.append(
        create(
          "h3",
          "vote-lane-title",
          lane === "core"
            ? window.MrzhI18n.t("类型科技（第一行）")
            : window.MrzhI18n.t("其他科技（第二行）")
        )
      );
      const grid = create("div", "vote-lane-grid");
      for (const option of options) {
        const button = create("button", "vote-option");
        button.type = "button";
        button.disabled = summary.isOpen === false;
        button.dataset.key = option.key;
        button.dataset.selected = String(state.selections.has(option.key));
        if (option.iconUrl) {
          const image = document.createElement("img");
          image.className = "tech-icon";
          image.src = option.iconUrl;
          image.alt = "";
          image.loading = "lazy";
          button.append(image);
        } else {
          button.append(
            create(
              "span",
              "tech-icon tech-icon-placeholder",
              option.name.slice(0, 1)
            )
          );
        }
        const copy = create("span", "tech-copy");
        copy.append(create("strong", "", option.name));
        copy.append(
          create(
            "small",
            "",
            `${categoryName(option.category)} · ${laneName(option.lane)}`
          )
        );
        if (option.prerequisiteName) {
          copy.append(
            create(
              "small",
              "tech-prerequisite",
              window.MrzhI18n.format("前置科技：{name}", {
                name: option.prerequisiteName
              })
            )
          );
        }
        if (option.description) {
          copy.append(create("span", "tech-description", option.description));
        }
        button.append(
          copy,
          create(
            "span",
            "vote-count",
            `${option.votes} ${window.MrzhI18n.t("票")}`
          )
        );
        button.addEventListener("click", () => toggleVote(summary, option));
        grid.append(button);
      }
      section.append(grid);
      root.append(section);
    }
  }

  function renderVoteSelection(summary, target = byId("vote-selection-preview")) {
    const root = target;
    if (!root) return;
    root.replaceChildren();
    for (const lane of ["core", "general"]) {
      const row = create("section", "vote-selection-row");
      row.append(
        create(
          "span",
          "vote-selection-label",
          lane === "core"
            ? window.MrzhI18n.t("类型科技")
            : window.MrzhI18n.t("其他科技")
        )
      );
      const slots = create("div", "vote-selection-slots");
      const technologies = summary.projectedPlan?.[lane] || [];
      for (let index = 0; index < 6; index += 1) {
        const option = technologies[index];
        const slot = create(
          "span",
          `vote-selection-slot${option ? " is-filled" : ""}`
        );
        if (option?.iconUrl) {
          const image = document.createElement("img");
          image.src = option.iconUrl;
          image.alt = option.name;
          slot.append(image);
        } else if (option) {
          slot.textContent = option.name.slice(0, 1);
        } else {
          slot.textContent = "+";
        }
        if (option) slot.title = option.name;
        slots.append(slot);
      }
      row.append(slots);
      root.append(row);
    }
  }

  function renderHighlights(items) {
    const root = byId("highlights");
    root.replaceChildren();
    const entries = (items || []).map((item) =>
      typeof item === "string"
        ? { blocks: [{ type: "text", text: item }] }
        : item
    );
    if (!entries.length) {
      root.append(create("p", "empty-state", "当前没有需要公示的营地公告。"));
      return;
    }
    for (const [index, item] of entries.entries()) {
      const blocks = Array.isArray(item?.blocks) ? item.blocks : [];
      const card = create("article", "highlight-item");
      const header = create("div", "highlight-item-header");
      header.append(
        create("span", "highlight-item-index", String(index + 1).padStart(2, "0")),
        create("span", "highlight-item-label", "营地公告")
      );
      card.append(header);
      for (const block of blocks) {
        if (block?.type === "image" && /^https:\/\//i.test(String(block.url || ""))) {
          const figure = document.createElement("figure");
          figure.className = "highlight-image";
          const image = document.createElement("img");
          image.src = block.url;
          image.alt = block.alt || "营地公告图片";
          image.loading = "lazy";
          image.decoding = "async";
          image.tabIndex = 0;
          image.setAttribute("role", "button");
          image.setAttribute("aria-label", window.MrzhI18n.t("点击查看大图"));
          image.title = window.MrzhI18n.t("点击查看大图");
          image.addEventListener("click", () => openImagePreview(block.url, image.alt));
          image.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              openImagePreview(block.url, image.alt);
            }
          });
          image.addEventListener("error", () => {
            figure.classList.add("is-broken");
          }, { once: true });
          figure.append(image);
          card.append(figure);
        } else if (block?.type === "text" && String(block.text || "").trim()) {
          const copy = document.createElement("p");
          copy.className = "highlight-copy";
          copy.textContent = block.text;
          card.append(copy);
        }
      }
      if (card.childElementCount > 1) root.append(card);
    }
  }

  function renderRichBlocks(root, blocks, emptyText = "") {
    for (const block of Array.isArray(blocks) ? blocks : []) {
      if (block?.type === "image" && /^https:\/\//i.test(String(block.url || ""))) {
        const figure = document.createElement("figure");
        figure.className = "highlight-image daily-rich-image";
        const image = document.createElement("img");
        image.src = block.url;
        image.alt = block.alt || window.MrzhI18n.t("公告图片");
        image.loading = "lazy";
        image.decoding = "async";
        image.tabIndex = 0;
        image.setAttribute("role", "button");
        image.setAttribute("aria-label", window.MrzhI18n.t("点击查看大图"));
        image.addEventListener("click", () => openImagePreview(block.url, image.alt));
        image.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openImagePreview(block.url, image.alt);
          }
        });
        figure.append(image);
        root.append(figure);
      } else if (block?.type === "text" && String(block.text || "").trim()) {
        root.append(create("p", "daily-rich-text", block.text));
      }
    }
    if (!root.childElementCount && emptyText) root.append(create("p", "empty-state", emptyText));
  }

  function dailyDate(value) {
    return value ? formatDate(value) : "—";
  }

  function dailyKindName(kind) {
    return window.MrzhI18n.t(kind === "draw" ? "抽签事项" : "投票事项");
  }

  function dailySelections(itemId) {
    const values = state.dailySelections[itemId];
    return Array.isArray(values) ? values : [];
  }

  function appendDailyIdentityControls(card, itemId) {
    const row = create("div", "identity-vote-row daily-item-identity-row");
    const label = document.createElement("label");
    label.className = "field identity-code-field";
    label.append(create("span", "", "身份识别码（必填）"));
    const input = document.createElement("input");
    input.className = "daily-identity-code";
    input.dataset.dailyItemId = itemId;
    input.inputMode = "numeric";
    input.autocomplete = "one-time-code";
    input.placeholder = window.MrzhI18n.t("请输入身份识别码");
    const hasState = Object.prototype.hasOwnProperty.call(state.dailyIdentityCodes, itemId);
    input.value = hasState ? state.dailyIdentityCodes[itemId] : rememberedIdentityCode();
    if (!hasState && input.value) state.dailyIdentityCodes[itemId] = input.value;
    input.required = true;
    input.addEventListener("input", () => {
      state.dailyIdentityCodes[itemId] = input.value;
    });
    label.append(input);
    row.append(label);
    const actions = [
      ["申请身份识别码", () => openNewApplication()],
      ["申请延长识别码有效期", () => {
        const value = input.value.trim();
        openRenewalLookup(/^\d{8}$/.test(value) ? value : "");
      }],
      ["申请更换身份识别码", () => openReissue(input.value.trim())],
      ["忘记识别码", () => openIdentityRecovery()]
    ];
    for (const [labelText, handler] of actions) {
      const button = create("button", "button button-quiet", labelText);
      button.type = "button";
      button.addEventListener("click", handler);
      row.append(button);
    }
    card.append(row);
    return input;
  }

  function renderDailyItem(item) {
    const card = create("article", `daily-vote-item daily-vote-item-${item.kind}`);
    const heading = create("div", "daily-vote-item-heading");
    const title = create("div", "daily-vote-item-title");
    renderRichBlocks(title, item.titleBlocks, window.MrzhI18n.t("未命名事项"));
    heading.append(title, create("span", "daily-vote-kind", dailyKindName(item.kind)));
    card.append(heading);
    const description = create("div", "daily-vote-description");
    renderRichBlocks(description, item.descriptionBlocks);
    if (description.childElementCount) card.append(description);
    const meta = create("div", "daily-vote-meta");
    meta.append(
      create("span", "daily-vote-meta-item", window.MrzhI18n.format("开放 {start} · 截止 {end}", {
        start: dailyDate(item.startAt),
        end: dailyDate(item.endAt)
      }))
    );
    if (item.kind === "poll") {
      meta.append(create("span", "daily-vote-meta-item", window.MrzhI18n.format("每人可选 {count} 项", {
        count: item.maxSelections
      })));
    } else {
      meta.append(create("span", "daily-vote-meta-item", window.MrzhI18n.format("抽取 {count} 人 · 已报名 {participants} 人", {
        count: item.drawCount,
        participants: item.participantCount || 0
      })));
    }
    card.append(meta);
    const identityInput = appendDailyIdentityControls(card, item.id);
    if (item.kind === "poll") {
      const selected = new Set(dailySelections(item.id));
      const options = create("div", "daily-vote-options");
      for (const option of item.options || []) {
        const button = create("button", `daily-vote-option${selected.has(option.id) ? " is-selected" : ""}`);
        button.type = "button";
        button.disabled = item.isOpen === false;
        const content = create("span", "daily-vote-option-content");
        renderRichBlocks(content, option.blocks, window.MrzhI18n.t("未命名选项"));
        button.append(content, create("strong", "daily-vote-option-count", window.MrzhI18n.format("{count} 票", {
          count: option.votes || 0
        })));
        button.addEventListener("click", () => {
          const next = new Set(dailySelections(item.id));
          if (next.has(option.id)) next.delete(option.id);
          else if (next.size < Number(item.maxSelections || 0)) next.add(option.id);
          else {
            setText("daily-vote-status", window.MrzhI18n.format("最多选择 {count} 项", { count: item.maxSelections }));
            return;
          }
          state.dailySelections[item.id] = [...next];
          renderDailyVote(state.data?.dailyVote || {});
        });
        options.append(button);
      }
      card.append(options);
    }
    const action = create("div", "daily-vote-item-action");
    const submit = create("button", "button button-primary", item.kind === "draw" ? "提交抽签" : "提交投票");
    submit.type = "button";
    submit.disabled = item.isOpen === false;
    submit.addEventListener("click", () => submitDailyVote(item, identityInput));
    action.append(submit);
    card.append(action);
    return card;
  }

  function renderDailyHistory(payload) {
    const root = byId("daily-vote-history");
    if (!root) return;
    root.replaceChildren();
    const technology = payload?.technologyHistory || [];
    const technologySection = create("section", "daily-history-group");
    technologySection.append(create("h4", "daily-history-group-title", "科技投票 · 最近 7 天"));
    if (!technology.length) {
      technologySection.append(create("p", "empty-state", "当天无投票记录"));
    }
    for (const item of technology) {
      const card = create("article", "daily-history-card");
      card.append(create("strong", "daily-history-card-title", item.pollDate));
      const fixedTechnologies = Array.isArray(item.fixedTechnologies) ? item.fixedTechnologies : [];
      const hasRecords = Number(item.ballotCount || 0) > 0 || fixedTechnologies.length > 0;
      if (hasRecords) {
        const preview = create("div", "vote-selection-preview daily-history-selection-preview");
        renderVoteSelection(item, preview);
        card.append(preview);
        const fixedKeys = new Set(fixedTechnologies.map((fixed) => fixed.key));
        const result = create("div", "daily-history-result-list");
        for (const tech of [...(item.projectedPlan?.core || []), ...(item.projectedPlan?.general || [])]) {
          if (fixedKeys.has(tech.key)) continue;
          result.append(create("span", "daily-history-result", window.MrzhI18n.format("{name} · {count} 票", {
            name: tech.name,
            count: (item.options || []).find((option) => option.key === tech.key)?.votes || 0
          })));
        }
        for (const fixed of fixedTechnologies) {
          result.append(create("span", "daily-history-result is-fixed", window.MrzhI18n.format("{name} · 固定", { name: fixed.name })));
        }
        if (result.childElementCount) card.append(result);
      } else {
        card.append(create("p", "empty-state", "当天无投票记录"));
      }
      technologySection.append(card);
    }
    root.append(technologySection);
    for (const [kind, items] of [["poll", payload?.history?.polls || []], ["draw", payload?.history?.draws || []]]) {
      const section = create("section", "daily-history-group");
      section.append(create("h4", "daily-history-group-title", kind === "poll" ? "投票事项 · 最近 14 天" : "抽签事项 · 最近 14 天"));
      if (!items.length) {
        section.append(create("p", "empty-state", kind === "poll" ? "暂无历史投票事项。" : "暂无历史抽签事项。"));
      }
      for (const item of items) {
        const card = create("article", "daily-history-card");
        const title = create("div", "daily-history-card-title");
        renderRichBlocks(title, item.titleBlocks, window.MrzhI18n.t("未命名事项"));
        card.append(title, create("small", "muted", window.MrzhI18n.format("截止 {date} · 参与 {count} 人", {
          date: dailyDate(item.endAt), count: item.participantCount || 0
        })));
        if (kind === "poll") {
          const result = create("div", "daily-history-result-list");
          for (const option of item.options || []) {
            const optionText = create("span", "daily-history-result");
            renderRichBlocks(optionText, option.blocks);
            optionText.append(create("strong", "daily-history-result-count", window.MrzhI18n.format("{count} 票", { count: option.votes || 0 })));
            result.append(optionText);
          }
          card.append(result);
        } else {
          const winners = create("div", "daily-history-result-list");
          const winnerList = Array.isArray(item.winners)
            ? item.winners.filter(winner => winner && String(winner.playerName || "").trim())
            : [];
          if (winnerList.length) {
            card.append(create("p", "daily-history-winner-label", "中签人名单："));
          }
          for (const winner of winnerList) {
            winners.append(create("span", "daily-history-result is-winner", winner.playerName));
          }
          card.append(winners.childElementCount ? winners : create("p", "empty-state", "本次抽签无人报名"));
        }
        section.append(card);
      }
      root.append(section);
    }
    if (!root.childElementCount) root.append(create("p", "empty-state", "暂无历史投票结果。"));
  }

  function renderDailyVote(payload) {
    const root = byId("daily-vote-items");
    if (!root) return;
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const historyCount = (payload?.technologyHistory || []).length +
      (payload?.history?.polls || []).length +
      (payload?.history?.draws || []).length;
    root.replaceChildren();
    setText("feature-vote-count", String(dailyVoteFeatureCount(payload)));
    setText("daily-tech-panel-count", "1");
    setText("daily-items-panel-count", String(items.length));
    setText("daily-history-panel-count", String(historyCount));
    setText("daily-vote-status", items.length ? "" : window.MrzhI18n.t("当前没有开放事项。"));
    for (const item of items) root.append(renderDailyItem(item));
    renderDailyHistory(payload || {});
    const panelList = byId("daily-vote-panels");
    const panelDetail = byId("daily-vote-panel-detail");
    if (panelList) panelList.hidden = Boolean(state.dailyPanel);
    if (panelDetail) panelDetail.hidden = !state.dailyPanel;
    for (const panel of document.querySelectorAll("[data-daily-panel-content]")) {
      panel.hidden = panel.dataset.dailyPanelContent !== state.dailyPanel;
    }
    setText("hero-vote-count", String(dailyVoteFeatureCount(payload)));
    setText("feature-vote-count", String(dailyVoteFeatureCount(payload)));
    syncDailyFeatureBackButton();
  }

  function openDailyPanel(panel) {
    if (!["technology", "items", "history"].includes(panel)) return;
    state.dailyPanel = panel;
    renderDailyVote(state.data?.dailyVote || {});
  }

  function backDailyPanels() {
    state.dailyPanel = "";
    renderDailyVote(state.data?.dailyVote || {});
  }

  async function submitDailyVote(item, identityInput = byId("identity-code")) {
    const identityCode = identityInput?.value.trim() || "";
    if (!/^\d{8}$/.test(identityCode)) {
      showVoteError(window.MrzhI18n.t("请输入身份识别码。"), window.MrzhI18n.t("日常投票未提交"));
      return;
    }
    const selections = item.kind === "poll" ? dailySelections(item.id) : [];
    if (item.kind === "poll" && !selections.length) {
      setText("daily-vote-status", window.MrzhI18n.t("请至少选择一项。"));
      return;
    }
    try {
      setText("daily-vote-status", window.MrzhI18n.t("正在提交…"));
      const payload = await request("/api/public/daily-vote", {
        method: "POST",
        body: JSON.stringify({
          itemId: item.id,
          identityCode,
          locale: window.MrzhI18n.language(),
          selections
        })
      });
      rememberIdentityCode(identityCode);
      state.dailySelections[item.id] = [];
      if (state.data) state.data.dailyVote = payload;
      renderDailyVote(payload);
      setText("daily-vote-status", window.MrzhI18n.t("提交成功，票数已更新。"));
      showVoteSuccessDialog({
        kind: "daily",
        data: payload,
        message: payload.publicTestVote
          ? window.MrzhI18n.t("测试成功，本次提交不计票。")
          : payload.renewalGraceUsed
            ? window.MrzhI18n.t("投票已提交；本次已使用延期审批期间唯一一次过期投票机会。")
            : window.MrzhI18n.t("提交成功，票数已更新。")
      });
    } catch (error) {
      showVoteError(window.MrzhI18n.t(error.message), window.MrzhI18n.t("日常投票未提交"), error.code === "identity_code_expired" && error.canRenew, identityCode);
    }
  }

  function openImagePreview(url, alt = "营地公告图片") {
    const dialog = byId("image-preview-dialog");
    const image = byId("image-preview");
    if (!dialog || !image) {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    image.src = url;
    image.alt = alt;
    if (typeof dialog.showModal === "function") {
      if (!dialog.open) dialog.showModal();
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  function renderStaff(items) {
    const root = byId("staff-list");
    root.replaceChildren();
    if (!items?.length) {
      root.append(create("p", "empty-state", "公职数据等待同步。"));
      return;
    }
    for (const item of items) {
      const card = create("article", "staff-card");
      card.append(
        create(
          "strong",
          "",
          item.role_name || item.roleName || window.MrzhI18n.t("公职")
        ),
        create(
          "span",
          "",
          item.member_name || item.memberName || window.MrzhI18n.t("待同步")
        )
      );
      root.append(card);
    }
    const updated = items.map((item) => item.updated_at).filter(Boolean).sort().at(-1);
    setText(
      "staff-updated",
      updated
        ? window.MrzhI18n.format("更新于 {date}", { date: formatDate(updated) })
        : ""
    );
  }

  function renderMembers(items) {
    const query = state.memberQuery.toLowerCase();
    const filtered = (items || []).filter((item) =>
      [item.name, item.profession, item.roommate_name, item.camp_title]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query))
    );
    const root = byId("member-table");
    root.replaceChildren();
    byId("member-empty").hidden = filtered.length > 0;
    for (const item of filtered) {
      const row = document.createElement("tr");
      for (const [value, className] of [
        [item.name, ""],
        [item.profession || "—", ""],
        [item.manor_level ?? "—", "numeric"],
        [item.roommate_name || "—", ""],
        [item.weekly_contribution ?? 0, "numeric"],
        [item.technology_points_used ?? 0, "numeric"],
        [item.material_contribution ?? 0, "numeric"]
      ]) {
        row.append(create("td", className, String(value)));
      }
      root.append(row);
    }
  }

  function renderWarnings(items, thresholdDays) {
    setText(
      "warning-description",
      window.MrzhI18n.format(
        "根据营地惯例，离线超过 {days} 天的玩家可能会被请离营地。",
        { days: thresholdDays }
      )
    );
    setText("warning-count", String(items.length));
    byId("warning-empty").hidden = items.length > 0;
    const root = byId("warning-list");
    root.replaceChildren();
    for (const item of items) {
      const card = create("article", "warning-card");
      card.append(
        create("strong", "", item.name),
        create(
          "span",
          "",
          item.last_active_text ||
            window.MrzhI18n.format("{days} 天前", { days: item.inactive_days })
        )
      );
      root.append(card);
    }
  }

  function renderRuns(items) {
    const root = byId("run-list");
    root.replaceChildren();
    if (!items?.length) {
      root.append(create("p", "empty-state", "暂无自动任务记录。"));
      return;
    }
    for (const item of items) {
      const row = create("div", "run-item");
      row.append(
        create("time", "muted", formatDate(item.finishedAt || item.createdAt)),
        create("strong", "", taskName(item.taskKey)),
        create(
          "span",
          `status-badge status-${item.state}`,
          stateName(item.state)
        )
      );
      root.append(row);
    }
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
      hour12: false
    }).format(new Date(value));
  }

  function configuredTimezone() {
    return state.data?.campConfig?.timezone || "Asia/Shanghai";
  }

  function render(data) {
    state.data = data;
    applyPluginVisibility();
    document.documentElement.dataset.timezone =
      data.campConfig?.timezone || "Asia/Shanghai";
    const siteName = data.siteName || "明日之后“愿”营地助手";
    document.title = window.MrzhI18n.t(siteName);
    setText("site-name", window.MrzhI18n.t(siteName));
    setText("camp-name", data.campConfig?.campName || "未命名营地");
    setText("server-name", data.campConfig?.serverName || "中国大陆服务器");
    setText("announcement", data.publicOverview?.announcement || "");
    setText("timezone-label", data.campConfig?.timezone || "Asia/Shanghai");
    const listedMemberCount = data.members?.length || 0;
    const reportedMemberCount = Number(data.memberSummary?.expectedCount);
    const totalMemberCount = Number.isInteger(reportedMemberCount) && reportedMemberCount >= 0
      ? reportedMemberCount
      : listedMemberCount;
    setText("hero-member-count", String(totalMemberCount));
    setText(
      "member-list-count",
      `当前列表 ${listedMemberCount} / 总人数 ${totalMemberCount}`
    );
    setText(
      "hero-warning-count",
      String(data.inactivityWarnings?.length || 0)
    );
    setText(
      "hero-vote-count",
      String(data.voteSummary?.ballotCount || 0)
    );
    const highlightCount = Array.isArray(data.publicOverview?.highlights)
      ? data.publicOverview.highlights.length
      : 0;
    setText("feature-overview-count", String(highlightCount));
    setText("overview-count", String(highlightCount));
    setText("feature-staff-count", String(data.staffAssignments?.length || 0));
    setText(
      "feature-warning-count",
      String(data.inactivityWarnings?.length || 0)
    );
    setText("feature-vote-count", String(dailyVoteFeatureCount(data.dailyVote)));
    setText("feature-members-count", String(totalMemberCount));
    setText("feature-runs-count", String(data.recentRuns?.length || 0));
    const memberSync = (data.recentRuns || []).find(
      (run) =>
        run.taskKey === "member_profile_sync" &&
        ["succeeded", "partially_succeeded"].includes(run.state)
    );
    setText(
      "sync-state",
      memberSync
        ? window.MrzhI18n.format("已同步 {date}", {
            date: formatDate(memberSync.finishedAt)
          })
        : window.MrzhI18n.t("等待首次同步")
    );
    renderHighlights(data.publicOverview?.highlights || []);
    renderVote(data.voteSummary || { options: [] });
    renderDailyVote(data.dailyVote || {});
    renderStaff(data.staffAssignments || []);
    renderWarnings(
      data.inactivityWarnings || [],
      data.campConfig?.inactivityWarningDays || 1
    );
    renderMembers(data.members || []);
    renderRuns(data.recentRuns || []);
    if (state.activeFeature) {
      const activeCard = document.querySelector(
        `.feature-card[data-feature-target="${state.activeFeature}"]`
      );
      if (activeCard && !activeCard.hidden) {
        showFeature(state.activeFeature, { updateHash: false });
      } else {
        byId("feature-detail-dialog")?.close();
      }
    }
  }

  async function load() {
    try {
      render(
        await request(
          `/api/public/bootstrap?t=${Date.now()}&locale=${encodeURIComponent(window.MrzhI18n.language())}`
        )
      );
    } catch (error) {
      setText(
        "announcement",
        window.MrzhI18n.format("公共数据加载失败：{message}", {
          message: error.message
        })
      );
    }
  }

  async function refreshFromLiveUpdate() {
    if (document.hidden || !state.data) {
      state.liveDirty = true;
      return;
    }
    if (state.liveRefreshInFlight) {
      state.liveRefreshQueued = true;
      return;
    }
    state.liveRefreshInFlight = true;
    state.liveDirty = false;
    try {
      await load();
    } finally {
      state.liveRefreshInFlight = false;
      if (state.liveRefreshQueued) {
        state.liveRefreshQueued = false;
        void refreshFromLiveUpdate();
      }
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
      `${scheme}//${window.location.host}/api/live?scope=public`
    );
    state.liveSocket = socket;
    socket.addEventListener("open", () => {
      if (state.liveSocket !== socket) return;
      state.liveReconnectAttempt = 0;
      socket.send(JSON.stringify({ type: "subscribe", scope: "public" }));
      void refreshFromLiveUpdate();
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
        message.scopes.includes("public")
      ) {
        void refreshFromLiveUpdate();
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

  async function submitVote() {
    const button = byId("submit-vote");
    const feedback = byId("vote-feedback");
    if (state.data?.voteSummary?.isOpen === false) {
      feedback.textContent = window.MrzhI18n.t("当前不在科技投票开放时间内。");
      return;
    }
    if (state.selections.size > configuredVoteLimit(state.data?.voteSummary)) {
      feedback.textContent = window.MrzhI18n.format("每人最多选择 {limit} 项科技。", {
        limit: configuredVoteLimit(state.data?.voteSummary)
      });
      return;
    }
    const identityCode = byId("identity-code").value.trim();
    if (!/^\d{8}$/.test(identityCode)) {
      showVoteError(window.MrzhI18n.t("请输入身份识别码。"));
      return;
    }
    button.disabled = true;
    feedback.textContent = "正在提交…";
    try {
      const summary = await request("/api/public/tech-vote", {
        method: "POST",
        body: JSON.stringify({
          identityCode,
          locale: window.MrzhI18n.language(),
          selections: [...state.selections]
        })
      });
      rememberIdentityCode(identityCode);
      state.selections.clear();
      if (state.data) state.data.voteSummary = summary;
      renderVote(summary);
      feedback.textContent = summary.voteWithdrawn
        ? window.MrzhI18n.t("投票已撤回，当前不计入投票人数。")
        : window.MrzhI18n.t("投票已保存，可在截止前再次修改。");
      showVoteSuccessDialog({
        kind: "technology",
        data: summary,
        message: summary.voteWithdrawn
          ? window.MrzhI18n.t("投票已撤回，当前不计入投票人数。")
          : summary.publicTestVote
            ? window.MrzhI18n.t("测试成功，本次提交不计票。")
            : summary.renewalGraceUsed
              ? window.MrzhI18n.t("投票已提交；本次已使用延期审批期间唯一一次过期投票机会。")
              : window.MrzhI18n.t("投票已保存，可在截止前再次修改。")
      });
    } catch (error) {
      const message =
        error.code === "rate_limited" ||
        error.code === "identity_code_rate_limited"
          ? window.MrzhI18n.format("尝试次数过多，请在 {seconds} 秒后重试。", {
              seconds: error.retryAfterSeconds || "—"
            })
          : window.MrzhI18n.t(error.message);
      showVoteError(
        message,
        window.MrzhI18n.t("投票未提交"),
        error.code === "identity_code_expired" && error.canRenew,
        identityCode
      );
    } finally {
      button.disabled = false;
    }
  }

  function showVoteError(
    message,
    title = window.MrzhI18n.t("投票未提交"),
    canRenew = false,
    identityCode = ""
  ) {
    setText("vote-feedback", message);
    setText("vote-error-title", title);
    setText("vote-error-message", message);
    state.voteErrorRenewalCode = canRenew ? identityCode : "";
    byId("vote-error-renew").hidden = !canRenew;
    const dialog = byId("vote-error-dialog");
    if (!dialog.open) dialog.showModal();
  }

  function showIdentityApplicationError(message) {
    setText("identity-application-error-message", window.MrzhI18n.t(message));
    const dialog = byId("identity-application-error-dialog");
    if (!dialog.open) dialog.showModal();
  }

  function showIdentityApplicationSuccess(message) {
    setText("identity-application-success-title", window.MrzhI18n.t("申请已提交"));
    setText("identity-application-success-message", message);
    setText(
      "identity-application-success-notice",
      window.MrzhI18n.t(
        "申请已成功提交，预计于48小时内完成审核，请留意邮箱的审核结果邮件。"
      )
    );
    const applicationDialog = byId("identity-application-dialog");
    if (applicationDialog?.open) applicationDialog.close();
    const dialog = byId("identity-application-success-dialog");
    if (dialog && !dialog.open) dialog.showModal();
  }

  function openNewApplication() {
    state.identityMode = "new";
    state.renewalCode = "";
    state.renewalApplicationNumber = "";
    setText("identity-dialog-title", window.MrzhI18n.t("申请身份识别码"));
    byId("identity-renewal-number").hidden = true;
    byId("identity-email").value = "";
    byId("identity-player-name").value = "";
    byId("identity-recovery-number-field").hidden = true;
    byId("identity-reissue-code-field").hidden = true;
    byId("identity-reissue-application-number-field").hidden = true;
    byId("identity-renewal-application-number-field").hidden = true;
    byId("identity-renewal-code-field").hidden = true;
    byId("identity-email-field").hidden = false;
    byId("identity-player-name-field").hidden = false;
    byId("identity-rules").hidden = false;
    byId("identity-recovery-rules").hidden = true;
    byId("identity-reissue-rules").hidden = true;
    byId("identity-renewal-lookup-rules").hidden = true;
    setText("identity-email-label", window.MrzhI18n.t("接收识别码邮箱"));
    setText("identity-player-name-label", window.MrzhI18n.t("玩家名称"));
    setText("submit-identity-application", window.MrzhI18n.t("提交申请"));
    setText("identity-application-feedback", "");
    byId("identity-application-dialog").showModal();
  }

  function showRenewalConfirmation(
    preview,
    { identityCode = "", applicationNumber = "" } = {}
  ) {
    state.identityMode = "renewal";
    state.renewalCode = identityCode;
    state.renewalApplicationNumber =
      preview.applicationNumber || applicationNumber;
    setText("identity-dialog-title", window.MrzhI18n.t("申请延长识别码有效期"));
    setText(
      "identity-renewal-number",
      window.MrzhI18n.format("申请编号：{number}", {
        number: preview.applicationNumber
      })
    );
    byId("identity-renewal-number").hidden = false;
    byId("identity-recovery-number-field").hidden = true;
    byId("identity-reissue-code-field").hidden = true;
    byId("identity-reissue-application-number-field").hidden = true;
    byId("identity-renewal-application-number-field").hidden = true;
    byId("identity-renewal-code-field").hidden = true;
    byId("identity-email-field").hidden = false;
    byId("identity-player-name-field").hidden = false;
    byId("identity-rules").hidden = false;
    byId("identity-recovery-rules").hidden = true;
    byId("identity-reissue-rules").hidden = true;
    byId("identity-renewal-lookup-rules").hidden = true;
    setText("identity-email-label", window.MrzhI18n.t("接收识别码邮箱"));
    setText("identity-player-name-label", window.MrzhI18n.t("玩家名称"));
    setText("submit-identity-application", window.MrzhI18n.t("提交延期申请"));
    byId("identity-email").value = preview.email;
    byId("identity-player-name").value = preview.playerName;
    setText("identity-application-feedback", "");
    const dialog = byId("identity-application-dialog");
    if (!dialog.open) dialog.showModal();
  }

  async function openRenewal(identityCode, applicationNumber = "") {
    const feedback = byId("vote-feedback");
    try {
      const preview = await request("/api/public/identity-code-renewal-preview", {
        method: "POST",
        body: JSON.stringify({ identityCode, applicationNumber })
      });
      showRenewalConfirmation(preview, { identityCode, applicationNumber });
    } catch (error) {
      feedback.textContent =
        error.code === "rate_limited" ||
        error.code === "identity_code_rate_limited"
          ? window.MrzhI18n.format("尝试次数过多，请在 {seconds} 秒后重试。", {
              seconds: error.retryAfterSeconds || "—"
            })
          : window.MrzhI18n.t(error.message);
    }
  }

  function openRenewalLookup(identityCode = "") {
    state.identityMode = "renewal-lookup";
    state.renewalCode = "";
    state.renewalApplicationNumber = "";
    setText("identity-dialog-title", window.MrzhI18n.t("申请延长识别码有效期"));
    byId("identity-renewal-number").hidden = true;
    byId("identity-recovery-number-field").hidden = true;
    byId("identity-reissue-code-field").hidden = true;
    byId("identity-reissue-application-number-field").hidden = true;
    byId("identity-renewal-application-number-field").hidden = false;
    byId("identity-renewal-code-field").hidden = false;
    byId("identity-email-field").hidden = true;
    byId("identity-player-name-field").hidden = true;
    byId("identity-rules").hidden = true;
    byId("identity-recovery-rules").hidden = true;
    byId("identity-reissue-rules").hidden = true;
    byId("identity-renewal-lookup-rules").hidden = false;
    byId("identity-renewal-application-number").value = "";
    byId("identity-renewal-code").value = identityCode;
    setText("submit-identity-application", window.MrzhI18n.t("下一步：核对信息"));
    setText("identity-application-feedback", "");
    byId("identity-application-dialog").showModal();
  }

  function openReissue(identityCode = "") {
    state.identityMode = "reissue-lookup";
    state.renewalCode = "";
    state.renewalApplicationNumber = "";
    state.reissueCode = "";
    state.reissueApplicationNumber = "";
    state.reissueEmail = "";
    state.reissuePlayerName = "";
    setText("identity-dialog-title", window.MrzhI18n.t("申请更换身份识别码"));
    byId("identity-renewal-number").hidden = true;
    byId("identity-recovery-number-field").hidden = true;
    byId("identity-reissue-application-number-field").hidden = false;
    byId("identity-reissue-code-field").hidden = false;
    byId("identity-renewal-application-number-field").hidden = true;
    byId("identity-renewal-code-field").hidden = true;
    byId("identity-email-field").hidden = false;
    byId("identity-player-name-field").hidden = false;
    byId("identity-rules").hidden = true;
    byId("identity-recovery-rules").hidden = true;
    byId("identity-reissue-rules").hidden = false;
    byId("identity-renewal-lookup-rules").hidden = true;
    setText("identity-email-label", window.MrzhI18n.t("申请时预留的邮箱"));
    setText("identity-player-name-label", window.MrzhI18n.t("玩家名称"));
    setText("submit-identity-application", window.MrzhI18n.t("下一步：核对信息"));
    byId("identity-reissue-application-number").value = "";
    byId("identity-reissue-code").value = identityCode;
    byId("identity-email").value = "";
    byId("identity-player-name").value = "";
    setText("identity-application-feedback", "");
    byId("identity-application-dialog").showModal();
  }

  function showReissueConfirmation(preview, lookup) {
    state.identityMode = "reissue";
    state.reissueCode = lookup.identityCode;
    state.reissueApplicationNumber =
      lookup.applicationNumber || preview.applicationNumber || "";
    state.reissueEmail = lookup.email;
    state.reissuePlayerName = lookup.playerName;
    setText("identity-dialog-title", window.MrzhI18n.t("申请更换身份识别码"));
    setText(
      "identity-renewal-number",
      window.MrzhI18n.format("申请编号：{number}", {
        number: preview.applicationNumber
      })
    );
    byId("identity-renewal-number").hidden = false;
    byId("identity-recovery-number-field").hidden = true;
    byId("identity-reissue-code-field").hidden = true;
    byId("identity-reissue-application-number-field").hidden = true;
    byId("identity-renewal-application-number-field").hidden = true;
    byId("identity-renewal-code-field").hidden = true;
    byId("identity-email-field").hidden = false;
    byId("identity-player-name-field").hidden = false;
    byId("identity-rules").hidden = true;
    byId("identity-recovery-rules").hidden = true;
    byId("identity-reissue-rules").hidden = false;
    byId("identity-renewal-lookup-rules").hidden = true;
    setText("identity-email-label", window.MrzhI18n.t("申请时预留的邮箱"));
    setText("identity-player-name-label", window.MrzhI18n.t("玩家名称"));
    setText("submit-identity-application", window.MrzhI18n.t("提交更换申请"));
    byId("identity-email").value = lookup.email || preview.email;
    byId("identity-player-name").value = lookup.playerName || preview.playerName;
    setText("identity-application-feedback", "");
  }

  function openIdentityRecovery() {
    state.identityMode = "recovery";
    state.renewalCode = "";
    state.renewalApplicationNumber = "";
    setText("identity-dialog-title", window.MrzhI18n.t("找回身份识别码"));
    byId("identity-renewal-number").hidden = true;
    byId("identity-recovery-number-field").hidden = false;
    byId("identity-reissue-code-field").hidden = true;
    byId("identity-reissue-application-number-field").hidden = true;
    byId("identity-renewal-application-number-field").hidden = true;
    byId("identity-renewal-code-field").hidden = true;
    byId("identity-email-field").hidden = false;
    byId("identity-player-name-field").hidden = false;
    byId("identity-rules").hidden = true;
    byId("identity-recovery-rules").hidden = false;
    byId("identity-reissue-rules").hidden = true;
    byId("identity-renewal-lookup-rules").hidden = true;
    setText(
      "identity-email-label",
      window.MrzhI18n.t("申请时预留的邮箱")
    );
    setText("identity-player-name-label", window.MrzhI18n.t("玩家名称"));
    byId("identity-recovery-number").value = "";
    byId("identity-email").value = "";
    byId("identity-player-name").value = "";
    setText("submit-identity-application", window.MrzhI18n.t("发送识别码到预留邮箱"));
    setText("identity-application-feedback", "");
    byId("identity-application-dialog").showModal();
  }

  async function submitIdentityApplication(event) {
    event.preventDefault();
    const button = byId("submit-identity-application");
    const feedback = byId("identity-application-feedback");
    const renewalLookup = state.identityMode === "renewal-lookup";
    const reissueLookup = state.identityMode === "reissue-lookup";
    const renewalLookupApplicationNumber =
      byId("identity-renewal-application-number").value.trim();
    const renewalLookupCode = byId("identity-renewal-code").value.trim();
    if (
      renewalLookup &&
      !renewalLookupApplicationNumber &&
      !renewalLookupCode
    ) {
      feedback.textContent = window.MrzhI18n.t(
        "请填写申请编号或身份识别码"
      );
      return;
    }
    if (
      reissueLookup &&
      !byId("identity-reissue-application-number").value.trim() &&
      !byId("identity-reissue-code").value.trim() &&
      !byId("identity-email").value.trim() &&
      !byId("identity-player-name").value.trim()
    ) {
      feedback.textContent = window.MrzhI18n.t(
        "请至少填写申请编号、玩家名称、申请时预留邮箱或旧识别码中的一项。"
      );
      return;
    }
    if (
      state.identityMode === "reissue" &&
      (!byId("identity-email").value.trim() ||
        !byId("identity-player-name").value.trim())
    ) {
      feedback.textContent = window.MrzhI18n.t(
        "请核对玩家名称和申请时预留邮箱"
      );
      return;
    }
    button.disabled = true;
    feedback.textContent = window.MrzhI18n.t("正在提交…");
    try {
      if (renewalLookup) {
        const preview = await request(
          "/api/public/identity-code-renewal-preview",
          {
            method: "POST",
            body: JSON.stringify({
              identityCode: renewalLookupCode,
              applicationNumber: renewalLookupApplicationNumber
            })
          }
        );
        showRenewalConfirmation(preview, {
          identityCode: renewalLookupCode,
          applicationNumber: renewalLookupApplicationNumber
        });
        return;
      }
      if (reissueLookup) {
        const lookup = {
          applicationNumber:
            byId("identity-reissue-application-number").value.trim(),
          identityCode: byId("identity-reissue-code").value.trim(),
          email: byId("identity-email").value.trim(),
          playerName: byId("identity-player-name").value.trim()
        };
        const preview = await request(
          "/api/public/identity-code-reissue-preview",
          {
            method: "POST",
            body: JSON.stringify(lookup)
          }
        );
        showReissueConfirmation(preview, lookup);
        return;
      }
      const common = {
        email: byId("identity-email").value.trim(),
        playerName: byId("identity-player-name").value.trim(),
        locale: window.MrzhI18n.language()
      };
      const result =
        state.identityMode === "renewal"
          ? await request("/api/public/identity-code-renewal", {
              method: "POST",
              body: JSON.stringify({
                ...common,
                identityCode: state.renewalCode,
                applicationNumber: state.renewalApplicationNumber
              })
            })
          : state.identityMode === "reissue"
            ? await request("/api/public/identity-code-reissue", {
                method: "POST",
                body: JSON.stringify({
                  ...common,
                  identityCode: state.reissueCode,
                  applicationNumber: state.reissueApplicationNumber,
                  lookupEmail: state.reissueEmail,
                  lookupPlayerName: state.reissuePlayerName
                })
              })
          : state.identityMode === "recovery"
            ? await request("/api/public/identity-code-recovery", {
                method: "POST",
                body: JSON.stringify({
                  ...common,
                  applicationNumber: byId("identity-recovery-number").value.trim()
                })
              })
            : await request("/api/public/identity-code-applications", {
              method: "POST",
              body: JSON.stringify(common)
            });
      if (state.identityMode === "recovery") {
        feedback.textContent = window.MrzhI18n.t(
          result.expired
            ? "识别码已发送至预留邮箱；该识别码已过期，可以申请延期。"
            : "识别码已发送至预留邮箱。"
        );
      } else {
        const applicationMessage = window.MrzhI18n.format(
          state.identityMode === "renewal"
            ? "延期申请已提交，申请编号：{number}。原有效期内可正常投票；过期后审批期间可额外投票一次。"
            : state.identityMode === "reissue"
              ? "更换申请已提交，申请编号：{number}。旧识别码已作废。"
            : "申请已提交，申请编号：{number}。",
          { number: result.applicationNumber }
        );
        feedback.textContent = applicationMessage;
        showIdentityApplicationSuccess(applicationMessage);
      }
    } catch (error) {
      const message =
        error.code === "rate_limited" ||
        error.code === "identity_code_rate_limited"
          ? window.MrzhI18n.format("尝试次数过多，请在 {seconds} 秒后重试。", {
              seconds: error.retryAfterSeconds || "—"
            })
          : window.MrzhI18n.t(error.message);
      feedback.textContent = message;
      if (
        error.message === ACTIVE_IDENTITY_CONFLICT ||
        error.message === EXPIRED_IDENTITY_CONFLICT
      ) {
        showIdentityApplicationError(error.message);
      }
    } finally {
      button.disabled = false;
    }
  }

  byId("submit-vote").addEventListener("click", submitVote);
  byId("identity-code").addEventListener("input", () => {
    state.identityCodeEdited = true;
  });
  hydrateRememberedIdentityCodeInputs();
  for (const panel of document.querySelectorAll("[data-daily-panel]")) {
    panel.addEventListener("click", () => openDailyPanel(panel.dataset.dailyPanel));
  }
  byId("apply-identity-code").addEventListener("click", openNewApplication);
  byId("recover-identity-code").addEventListener("click", openIdentityRecovery);
  byId("renew-identity-code").addEventListener("click", () => {
    const identityCode = byId("identity-code").value.trim();
    openRenewalLookup(/^\d{8}$/.test(identityCode) ? identityCode : "");
  });
  byId("reissue-identity-code").addEventListener("click", () => {
    const identityCode = byId("identity-code").value.trim();
    openReissue(identityCode);
  });
  byId("vote-error-renew").addEventListener("click", () => {
    const identityCode = state.voteErrorRenewalCode;
    byId("vote-error-dialog").close();
    if (identityCode) openRenewal(identityCode);
  });
  byId("image-preview-dialog").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });
  byId("image-preview-dialog").addEventListener("close", () => {
    byId("image-preview").removeAttribute("src");
  });
  byId("identity-application-form").addEventListener(
    "submit",
    submitIdentityApplication
  );
  byId("close-identity-dialog").addEventListener("click", () => {
    byId("identity-application-dialog").close();
  });
  byId("member-search").addEventListener("input", (event) => {
    state.memberQuery = event.target.value || "";
    renderMembers(state.data?.members || []);
  });
  initFeatureNavigation();
  document.addEventListener("mrzh:languagechange", () => {
    if (state.data) render(state.data);
    load();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.liveDirty) void refreshFromLiveUpdate();
    if (!document.hidden) connectLiveUpdates();
  });
  load();
  connectLiveUpdates();
})();
