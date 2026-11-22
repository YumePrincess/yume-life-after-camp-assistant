import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const read = file => readFileSync(new URL(`../public/js/${file}`, import.meta.url), "utf8");
const admin = read("admin.js"), publicSource = read("public.js");
const excerpt = (source, from, to) => source.slice(source.indexOf(`  ${from}`), source.indexOf(`  ${to}`));

class Element {
  constructor(tagName = "div", id = "") {
    Object.assign(this, { tagName: tagName.toUpperCase(), id, dataset: {}, children: [], isConnected: true,
      scrollTop: 0, scrollLeft: 0, value: "", checked: false, attributes: {} });
  }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) {
    for (const child of this.children) child.isConnected = false;
    this.children = items;
  }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [
      ...(child.tagName === "INPUT" && (selector !== "input:checked" || child.checked) ? [child] : []),
      ...child.querySelectorAll(selector)
    ]);
  }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener() {}
  getClientRects() { return this.hidden ? [] : [{}]; }
}

function viewState() {
  const elements = [];
  const window = { scrollX: 0, scrollY: 0, MrzhI18n: { language: () => "zh-cn" } };
  window.scrollTo = vi.fn(({ left, top }) => { window.scrollX = left; window.scrollY = top; });
  const document = {
    documentElement: { dataset: {} }, activeElement: null,
    querySelectorAll: selector => selector === "*" ? elements : elements.filter(el => el.dataset.refreshKey),
    getElementById: id => elements.find(el => el.id === id && el.isConnected)
  };
  runInNewContext(read("view-state.js"), { window, document });
  return { window, document, elements, ...window.MrzhViewState };
}

describe("background rendering keeps the reader's view", () => {
  it("preserves page, nested vertical/horizontal positions, disclosures and input focus during DOM replacement", () => {
    const ui = viewState();
    const list = new Element("div", "scrolling-list");
    list.scrollTop = 580; list.scrollLeft = 120;
    const details = new Element("details", "vote-management"); details.open = true;
    const input = new Element("input", "key-permission");
    Object.assign(input, { selectionStart: 1, selectionEnd: 3, selectionDirection: "forward" });
    ui.document.activeElement = input;
    ui.window.scrollY = 720;
    ui.elements.push(list, details, input);
    const nextInput = new Element("input", input.id);
    nextInput.focus = vi.fn(); nextInput.setSelectionRange = vi.fn();
    const nextDetails = new Element("details", details.id);
    ui.preserve(() => {
      list.scrollTop = 0; list.scrollLeft = 0; ui.window.scrollY = 0;
      input.isConnected = false; details.isConnected = false;
      ui.elements.push(nextInput, nextDetails);
    });
    expect([list.scrollTop, list.scrollLeft, ui.window.scrollY]).toEqual([580, 120, 720]);
    expect(nextDetails.open).toBe(true);
    expect(nextInput.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(nextInput.setSelectionRange).toHaveBeenCalledWith(1, 3, "forward");
  });

  it("captures the position at response time and handles nested render calls and rendering errors", async () => {
    const ui = viewState(); const list = new Element("div", "list"); ui.elements.push(list);
    list.scrollTop = 100;
    let resolve;
    const pending = new Promise(done => { resolve = done; }).then(() => ui.preserve(() => {
      ui.preserve(() => { list.scrollTop = 0; });
    }));
    list.scrollTop = 940; resolve(); await pending;
    expect(list.scrollTop).toBe(940);
    expect(() => ui.preserve(() => { list.scrollTop = 0; throw new Error("render failed"); })).toThrow();
    expect(list.scrollTop).toBe(940);
    ui.preserve(() => { list.scrollTop = 0; });
    expect(list.scrollTop).toBe(940);
  });

  it("does not reopen the active feature when an unrelated task updates", () => {
    const ui = viewState();
    const state = { data: { campConfig: {} }, activeFeature: "vote", selections: new Set(["tech-a"]), dailyPanel: "technology" };
    const showFeature = vi.fn(), close = vi.fn();
    const noOp = vi.fn();
    const nodes = { "feature-detail-dialog": { close } };
    const context = { window: { ...ui.window, MrzhCampGroup: { sourceUrl: () => "same" } }, document: {
      ...ui.document, querySelector: () => ({ hidden: false })
    }, state, byId: id => nodes[id], showFeature,
      identitySession: () => null, applyPluginVisibility: noOp, configuredTimezone: () => "UTC+08:00",
      setText: noOp, dailyVoteFeatureCount: () => 1, renderHighlights: noOp, renderVote: noOp,
      renderDailyVote: noOp, renderStaff: noOp, renderWarnings: noOp, renderMembers: noOp, renderRuns: noOp,
      syncFeatureDetailKicker: noOp };
    context.window.MrzhI18n.t = value => value;
    const render = runInNewContext(excerpt(publicSource, "function render(data)", "async function load()") + "\nrender", context);
    render({ campConfig: {}, recentRuns: [{ id: 2, state: "running" }] });
    expect(showFeature).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect([...state.selections]).toEqual(["tech-a"]);
    expect(state.dailyPanel).toBe("technology");
  });
});

describe("admin background updates retain operations and drafts", () => {
  it("does not let a background refresh replace a pending page navigation", async () => {
    const state = { dailyVotePage: 1 };
    const pending = [];
    const render = vi.fn();
    const load = runInNewContext(excerpt(admin, "async function loadDailyVoteAdmin(", "async function saveDailyVoteConfig(") + "\nloadDailyVoteAdmin", {
      state, URLSearchParams, canView: () => true,
      window: { MrzhI18n: { language: () => "zh-cn" }, MrzhFeedback: { begin: vi.fn(), end: vi.fn() } },
      request: url => new Promise(resolve => pending.push({ url, resolve })),
      renderDailyVoteAdmin: render, setFeedback: vi.fn()
    });
    const request = load("", 2, "active");
    await load("", 1, "active", true);
    expect(state.dailyVoteReloadRequest.page).toBe(2);
    await load("", 3, "active");
    await load("", 1, "active", true);
    expect(state.dailyVoteReloadRequest.page).toBe(3);
    pending[0].resolve({ page: 2 }); await request;
    expect(new URL(pending[1].url, "https://example.test").searchParams.get("page")).toBe("3");
    pending[1].resolve({ page: 3 }); await Promise.resolve(); await Promise.resolve();
    expect(render.mock.calls.at(-1)[0].page).toBe(3);
  });

  it.each([
    ["loadIdentityCodes", "openIdentityPasswordReset", "identityCodes", "renderIdentityCodes"],
    ["loadIdentityApplications", "renderIdentityApplications", "identityApplications", "renderIdentityApplications"],
    ["loadTemporaryKeys", "renderTemporaryKeys", "temporaryKeys", "renderTemporaryKeys"]
  ])("ignores an older %s response after a newer user request", async (name, next, key, renderName) => {
    const state = { [key]: { page: 1 } };
    const pending = [], urls = [], render = vi.fn();
    const load = runInNewContext(excerpt(admin, `async function ${name}(`, `function ${next}(`) + `\n${name}`, {
      state, URLSearchParams, canView: () => true,
      request: url => { urls.push(url); return new Promise(resolve => pending.push(resolve)); },
      [renderName]: render, setFeedback: vi.fn()
    });
    const older = load(1), newer = load(2), background = load(1, true);
    expect(new URL(urls[2], "https://example.test").searchParams.get("page")).toBe("2");
    pending[2]({ page: 2, items: [] }); await background;
    pending[1]({ page: 2, items: [] }); await newer;
    pending[0]({ page: 1, items: [] }); await older;
    expect(state[key].page).toBe(2);
    expect(render).toHaveBeenCalledOnce();
  });

  it.each([100, 700])("keeps a task timeline reader at %i unless they are following the latest events", async top => {
    const root = new Element("div", "run-events");
    Object.assign(root, { scrollTop: top, scrollHeight: 1000, clientHeight: 300, querySelector: () => null });
    root.append = (...items) => { root.children.push(...items); root.scrollHeight += 60; };
    const state = { activeEventRunId: "run-1", eventLoaded: true, eventLastId: 1, eventLocaleRevision: 0,
      eventEntries: [{ id: 1, message: "first" }] };
    const refresh = runInNewContext(excerpt(admin, "async function refreshRunEvents(", "function stopEventRefresh()") + "\nrefreshRunEvents", {
      state, byId: () => root, URLSearchParams,
      window: { MrzhI18n: { language: () => "zh-cn" } },
      request: async () => ({ events: [{ id: 2, message: "second" }] }),
      create: tag => new Element(tag), formatTaskLogTimestamp: value => value
    });
    await refresh("run-1");
    expect(root.children).toHaveLength(1);
    expect(root.scrollTop).toBe(top === 700 ? 1060 : top);
  });

  it("keeps a typed jump-page value while totals update, and synchronizes it after actual page navigation", () => {
    const control = new Element("input", "identity-code-jump");
    const sync = runInNewContext(excerpt(admin, "function syncPageJump(", "function setFeedback(") + "\nsyncPageJump", { byId: () => control });
    sync(control.id, 1, 10); expect(control.value).toBe("1");
    control.value = "8";
    sync(control.id, 1, 11); expect(control.value).toBe("8"); expect(control.max).toBe("11");
    sync(control.id, 8, 11); expect(control.value).toBe("8");
  });

  it("does not reload the active admin view or close its controls during bootstrap rendering", () => {
    const state = { activeView: "access" };
    const panel = Object.assign(new Element(), { dataset: { adminView: "access" } });
    const link = Object.assign(new Element(), { dataset: { navTarget: "access" } });
    const loadTemporaryKeys = vi.fn(), closeRunActionMenu = vi.fn();
    const activate = runInNewContext(excerpt(admin, "function activateView(", "function mountVoteAdminCards()") + "\nactivateView", {
      state, canView: () => true, closeRunActionMenu, loadTemporaryKeys,
      document: { querySelectorAll: selector => selector === "[data-admin-view]" ? [panel] : [link] }
    });
    activate("access", { reload: false });
    expect(loadTemporaryKeys).not.toHaveBeenCalled();
    expect(closeRunActionMenu).not.toHaveBeenCalled();
    activate("access");
    expect(loadTemporaryKeys).toHaveBeenCalledOnce();
  });

  it("does not overwrite unsaved daily vote settings after focus moves to another control", () => {
    const ui = viewState();
    const nodes = {};
    const byId = id => nodes[id] ||= new Element("div", id);
    const state = { dailyVoteConfigDirty: true, dailyVoteItemsByMode: {}, dailyVoteConfig: {} };
    byId("daily-vote-max-wins-per-month").value = "9";
    byId("vote-eligibility-enabled").checked = false;
    byId("vote-eligibility-min-contribution").value = "2000";
    const render = runInNewContext(excerpt(admin, "function renderDailyVoteAdmin(", "async function loadDailyVoteAdmin(") + "\nrenderDailyVoteAdmin", {
      state, byId, window: { ...ui.window, MrzhI18n: { t: value => value } },
      document: { activeElement: byId("some-other-button") },
      create: tag => new Element(tag), setText: vi.fn(), syncPageJump: vi.fn(), refreshOpenDailyVoteDetails: vi.fn()
    });
    render({ items: [], config: { drawMaxWinsPerMonth: 4, voteEligibilityEnabled: true, voteEligibility: { weeklyContribution: 1500 } } });
    expect(byId("daily-vote-max-wins-per-month").value).toBe("9");
    expect(byId("vote-eligibility-enabled").checked).toBe(false);
    expect(byId("vote-eligibility-min-contribution").value).toBe("2000");
    state.dailyVoteConfigDirty = false;
    render({ items: [], config: state.dailyVoteConfig });
    expect(byId("daily-vote-max-wins-per-month").value).toBe("4");
    expect(byId("vote-eligibility-enabled").checked).toBe(true);
  });

  it("keeps permission selections for unchanged catalogs and retains valid selections when the catalog changes", () => {
    const ui = viewState();
    const nodes = Object.fromEntries(["key-permission-options", "key-edit-permission-options"].map(id => [id, new Element("div", id)]));
    const state = { bootstrap: { permissionCatalog: [{ key: "admin:chat", label: "Chat" }, { key: "admin:tasks", label: "Tasks" }] } };
    const render = runInNewContext(excerpt(admin, "function renderPermissionOptions()", "function renderWorkspaceSummary(") + "\nrenderPermissionOptions", {
      state, byId: id => nodes[id], create: (tag, _, text) => Object.assign(new Element(tag), { textContent: text }), window: {
        ...ui.window, MrzhI18n: { ...ui.window.MrzhI18n, t: value => value }
      }
    });
    render();
    const controls = nodes["key-permission-options"].querySelectorAll("input");
    controls[0].checked = true;
    nodes["key-edit-permission-options"].querySelectorAll("input")[1].checked = true;
    render();
    expect(nodes["key-permission-options"].querySelectorAll("input")[0]).toBe(controls[0]);
    state.bootstrap.permissionCatalog.push({ key: "admin:members", label: "Members" }); render();
    expect(nodes["key-permission-options"].querySelectorAll("input:checked").map(el => el.value)).toEqual(["admin:chat"]);
    expect(nodes["key-edit-permission-options"].querySelectorAll("input:checked").map(el => el.value)).toEqual(["admin:tasks"]);
    state.bootstrap.permissionCatalog = [{ key: "admin:members", label: "Members" }]; render();
    expect(nodes["key-permission-options"].querySelectorAll("input:checked")).toHaveLength(0);
  });

  it("leaves configuration drafts and open schedule pickers alone while applying changed server sections", async () => {
    const bundle = { campConfig: { campName: "Camp" }, publicOverview: {}, authConfig: {}, technologyConfig: {},
      automationConfig: { tasks: { patrol: { enabled: true } }, agent: {}, gameWatchdog: {} } };
    const state = { bootstrap: { configBundle: structuredClone(bundle) }, activeView: "tasks", technologyDraft: {}, dirtySections: new Set(), scheduleDialogTaskKey: "patrol" };
    let next = { configBundle: structuredClone(bundle) };
    const render = vi.fn(data => { state.bootstrap = data; });
    const refreshViews = vi.fn();
    const refresh = runInNewContext(excerpt(admin, "async function refresh(forceAll", "function flushLiveRefresh()") + "\nrefresh", {
      state, CONFIG_SECTIONS: ["general", "tasks", "agent", "technology"], render,
      refreshOpenAdminViews: refreshViews, request: async () => next, flushLiveRefresh: vi.fn(), setFeedback: vi.fn(),
      window: { MrzhI18n: { language: () => "zh-cn" } }
    });
    await refresh(); expect(render.mock.calls.at(-1)[1]).toEqual([]);
    next = { configBundle: structuredClone(bundle) };
    next.configBundle.automationConfig.tasks.patrol.enabled = false;
    next.configBundle.campConfig.campName = "Updated camp";
    await refresh(); expect(render.mock.calls.at(-1)[1]).toEqual(["general"]);
    state.dirtySections.add("general");
    next = { configBundle: structuredClone(bundle) }; await refresh();
    expect(render.mock.calls.at(-1)[1]).toEqual([]);
    expect(refreshViews).toHaveBeenCalledTimes(3);
  });

  it("updates live task results and menu permissions in place without closing the menu", () => {
    const ui = viewState(); const root = new Element("tbody", "run-table");
    const trigger = new Element("button"); trigger.dataset.refreshKey = "run:1";
    const menu = new Element("div"); menu.remove = vi.fn();
    const state = { runActionMenu: { trigger, menu } };
    const context = { state, byId: () => root, window: ui.window,
      document: { createElement: tag => new Element(tag) }, create: (tag, className, text) => Object.assign(new Element(tag), { textContent: text }),
      createRunActionButton: () => new Element("button"), formatTaskLogTimestamp: value => value,
      taskName: value => value, stateName: value => value, hasPermission: () => true,
      ACTIVE_STATES: new Set(["running"]), positionRunActionMenu: vi.fn() };
    const code = excerpt(admin, "function renderRuns(runs)", "function openMaintenanceDialog(") +
      excerpt(admin, "function closeRunActionMenu()", "function positionRunActionMenu()") +
      excerpt(admin, "function toggleRunActionMenu(", "function activateView(");
    const api = runInNewContext(code + "\n({renderRuns,closeRunActionMenu})", context);
    api.renderRuns([{ id: 1, state: "running" }]);
    const eventButton = menu.children[0];
    expect(menu.children[1].disabled).toBe(false);
    api.renderRuns([{ id: 1, state: "succeeded" }]);
    expect(root.children[0].children[2].textContent).toBe("succeeded");
    expect(root.children[0].children[5].children[0]).toBe(trigger);
    expect(state.runActionMenu.trigger).toBe(trigger);
    expect(menu.children[0]).toBe(eventButton);
    expect(menu.children[1].disabled).toBe(true);
    expect(menu.remove).not.toHaveBeenCalled();
    api.closeRunActionMenu();
    expect(menu.remove).toHaveBeenCalledOnce();
  });

  it.each(["history", "daily"])("refreshes %s vote data silently in the background", async kind => {
    const begin = vi.fn(), end = vi.fn(), render = vi.fn();
    const state = { technologyHistoryLoading: false, dailyVoteLoading: false };
    const window = { MrzhI18n: { language: () => "zh-cn" }, MrzhFeedback: { begin, end } };
    const code = kind === "history"
      ? excerpt(admin, "async function loadTechnologyHistory(", "async function deleteTechnologyHistory(") + "\nloadTechnologyHistory"
      : excerpt(admin, "async function loadDailyVoteAdmin(", "async function saveDailyVoteConfig(") + "\nloadDailyVoteAdmin";
    const load = runInNewContext(code, { state, window, URLSearchParams, canView: () => true,
      request: async () => ({}), renderTechnologyHistory: render, renderDailyVoteAdmin: render, setFeedback: vi.fn() });
    if (kind === "history") await load("2026-10-18", true);
    else await load("", 2, "active", true);
    expect(begin).not.toHaveBeenCalled(); expect(end).not.toHaveBeenCalled(); expect(render).toHaveBeenCalled();
  });
});
