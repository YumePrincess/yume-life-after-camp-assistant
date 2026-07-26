(() => {
  "use strict";

  const state = {
    data: null,
    selections: new Set(),
    memberQuery: ""
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function setText(id, value) {
    const element = byId(id);
    if (element) element.textContent = value ?? "";
  }

  function create(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function voterId() {
    const key = "mrzh-voter-id";
    let value = localStorage.getItem(key);
    if (!value) {
      value = `web-${crypto.randomUUID()}`;
      localStorage.setItem(key, value);
    }
    return value;
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
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
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
      tech_switch: "科技切换",
      member_sync: "成员同步",
      patrol: "营地巡逻",
      brick_transport: "搬砖",
      weekly_schedule_update: "周日程更新"
    }[value];
    return source ? window.MrzhI18n.t(source) : value;
  }

  function stateName(value) {
    const source = {
      queued: "排队",
      claimed: "已领取",
      running: "执行中",
      cancelling: "中断中",
      interrupted: "已中断",
      succeeded: "成功",
      failed: "失败",
      skipped: "已跳过"
    }[value];
    return source ? window.MrzhI18n.t(source) : value;
  }

  function renderVote(summary) {
    setText("poll-date", summary.pollDate || "--");
    setText(
      "vote-deadline",
      window.MrzhI18n.format("共 {count} 人投票 · 截止 {closesAt}", {
        count: summary.ballotCount || 0,
        closesAt: summary.closesAt || "--"
      })
    );
    const root = byId("vote-options");
    root.replaceChildren();
    if (!summary.options?.length) {
      root.append(create("p", "empty-state", "管理员尚未开放科技投票。"));
      return;
    }
    for (const option of summary.options) {
      const button = create("button", "vote-option");
      button.type = "button";
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
        button.append(create("span", "tech-icon tech-icon-placeholder", option.name.slice(0, 1)));
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
      button.addEventListener("click", () => {
        if (state.selections.has(option.key)) state.selections.delete(option.key);
        else state.selections.add(option.key);
        button.dataset.selected = String(state.selections.has(option.key));
      });
      root.append(button);
    }
  }

  function renderHighlights(items) {
    const root = byId("highlights");
    root.replaceChildren();
    for (const item of items || []) {
      root.append(create("div", "highlight-item", item));
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
        create("span", "", item.last_active_text || `${item.inactive_days} 天前`)
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
        create("strong", "", taskName(item.taskKey)),
        create(
          "span",
          `status-badge status-${item.state}`,
          stateName(item.state)
        ),
        create("span", "muted", item.message || "—"),
        create("time", "muted", formatDate(item.finishedAt || item.createdAt))
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
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(value));
  }

  function render(data) {
    state.data = data;
    document.title = data.siteName || "明日之后营地助手";
    setText("site-name", data.siteName || "明日之后营地助手");
    setText("camp-name", data.campConfig?.campName || "未命名营地");
    setText("server-name", data.campConfig?.serverName || "中国大陆服务器");
    setText(
      "camp-type",
      `${categoryName(data.campConfig?.currentCampType)}${window.MrzhI18n.t("科技")}`
    );
    setText("announcement", data.publicOverview?.announcement || "");
    setText("timezone-label", data.campConfig?.timezone || "Asia/Shanghai");
    const memberSync = (data.recentRuns || []).find(
      (run) => run.taskKey === "member_sync" && run.state === "succeeded"
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
    renderStaff(data.staffAssignments || []);
    renderWarnings(
      data.inactivityWarnings || [],
      data.campConfig?.inactivityWarningDays || 1
    );
    renderMembers(data.members || []);
    renderRuns(data.recentRuns || []);
  }

  async function load() {
    try {
      render(await request(`/api/public/bootstrap?t=${Date.now()}`));
    } catch (error) {
      setText("announcement", `公共数据加载失败：${error.message}`);
    }
  }

  async function submitVote() {
    const button = byId("submit-vote");
    const feedback = byId("vote-feedback");
    if (!state.selections.size) {
      feedback.textContent = "请至少选择一项科技。";
      return;
    }
    button.disabled = true;
    feedback.textContent = "正在提交…";
    try {
      const summary = await request("/api/public/tech-vote", {
        method: "POST",
        body: JSON.stringify({
          voterId: voterId(),
          voterName: byId("voter-name").value.trim(),
          selections: [...state.selections]
        })
      });
      state.selections.clear();
      renderVote(summary);
      feedback.textContent = "投票已保存，可在截止前再次修改。";
    } catch (error) {
      feedback.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  byId("submit-vote").addEventListener("click", submitVote);
  byId("member-search").addEventListener("input", (event) => {
    state.memberQuery = event.target.value || "";
    renderMembers(state.data?.members || []);
  });
  load();
})();
