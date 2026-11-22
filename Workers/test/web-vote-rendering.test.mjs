import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const viewStateSource = readFileSync(new URL("../public/js/view-state.js", import.meta.url), "utf8");
const source = readFileSync(new URL("../public/js/public.js", import.meta.url), "utf8");
const technologyCode = source.slice(source.indexOf("  function optionMap("), source.indexOf("  function renderHighlights("));
const dailyCode = source.slice(source.indexOf("  function dailySelections("), source.indexOf("  function renderDailyHistory(")) +
  source.slice(source.indexOf("  function renderDailyVote("), source.indexOf("  async function submitDailyVote("));

class Element {
  constructor(tag = "div", className = "", text = "") {
    Object.assign(this, { tagName: tag, className, textContent: text, children: [], dataset: {}, attributes: {}, listeners: {}, scrollTop: 0 });
    this.classList = { toggle: (name, enabled) => {
      const classes = new Set(this.className.split(" ").filter(Boolean));
      if (enabled) classes.add(name); else classes.delete(name);
      this.className = [...classes].join(" ");
    } };
  }
  get childElementCount() { return this.children.length; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  click() { if (!this.disabled) this.listeners.click?.(); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [
      ...(child.className.split(" ").includes(selector.slice(1)) ? [child] : []),
      ...child.querySelectorAll(selector)
    ]);
  }
}

function setup(code) {
  const nodes = Object.fromEntries([
    "vote-options", "vote-selection-preview", "vote-window-state", "submit-vote",
    "daily-vote-items", "daily-vote-panels", "daily-vote-panel-detail"
  ].map(id => [id, new Element()]));
  const panels = ["technology", "items", "history"].map(name => {
    const node = new Element(); node.dataset.dailyPanelContent = name; return node;
  });
  const state = { selections: new Set(), dailySelections: {}, activeFeature: "vote", dailyPanel: "" };
  const environment = { language: "zh-cn", technologyParticipated: false, dailyParticipated: new Set() };
  const images = [];
  const notice = vi.fn();
  const history = vi.fn();
  const participants = vi.fn();
  const context = {
    state, byId: id => nodes[id], create: (tag, className, text) => new Element(tag, className, text),
    document: {
      createElement(tag) {
        const node = new Element(tag);
        if (tag === "img") images.push(node);
        return node;
      },
      documentElement: { dataset: {} },
      querySelectorAll: selector => selector === "*" ? [...Object.values(nodes), ...panels] : panels
    },
    window: { MrzhContentMedia: { card: () => new Element("button", "rich-video-card") }, MrzhI18n: {
      language: () => environment.language, t: value => value,
      format: (value, args) => value.replace(/\{(\w+)\}/g, (_, key) => String(args[key]))
    } },
    hasTechnologyParticipation: () => environment.technologyParticipated,
    hasDailyParticipation: id => environment.dailyParticipated.has(id),
    splitTimezoneSuffix: value => ({ value }), formatVoteDateTime: value => value,
    formatTimezoneLabel: value => value, configuredTimezone: () => "UTC+08:00",
    categoryName: value => value, laneName: value => value, dailyKindName: value => value,
    dailyOptionLabel: option => option.id, setText: vi.fn(), showOperationNotice: notice,
    openVoteParticipants: participants, renderIdentityAccount: vi.fn(), renderDailyHistory: history,
    dailyVoteFeatureCount: payload => (payload.items?.length || 0) + 2,
    syncFeatureDetailKicker: vi.fn(), resetFeatureScroll: vi.fn(), refreshVoteParticipation: vi.fn(),
    submitDailyVote: vi.fn(), showFeature: vi.fn(),
    renderRichBlocks: (root, blocks = []) => {
      for (const block of blocks) {
        const node = block.type === "video" ? context.window.MrzhContentMedia.card(block) : context.document.createElement(block.type === "image" ? "img" : "span");
        node.src = block.url; root.append(node);
      }
    }
  };
  runInNewContext(viewStateSource, context);
  const api = runInNewContext(`let renderedTechnologyVote = ""; let renderedDailyVote = ""; ${code}\n` +
    (code === technologyCode ? "({renderVote, toggleVote})" : "({renderDailyVote, openDailyPanel, backDailyPanels})"), context);
  return { ...api, state, nodes, panels, images, environment, notice, history, participants, setText: context.setText };
}

const summary = {
  voteLimit: 2, isOpen: true, pollDate: "2026-10-18", ballotCount: 0,
  projectedPlan: { core: [{ key: "a", name: "科技甲", iconUrl: "/a.png" }] },
  options: [
    { key: "a", name: "科技甲", iconUrl: "/a.png", lane: "core", votes: 0 },
    { key: "b", name: "科技乙", iconUrl: "/b.png", lane: "core", votes: 0, prerequisiteKey: "a" },
    { key: "c", name: "科技丙", iconUrl: "/c.png", lane: "general", votes: 0 }
  ]
};
const payload = { items: ["one", "two"].map(id => ({
  id, kind: "poll", maxSelections: 1, isOpen: true,
  options: ["a", "b"].map(value => ({ id: `${id}-${value}`, blocks: [{ type: "image", url: `/${id}-${value}.png` }] }))
})) };

describe("vote clicks preserve loaded icons and card nodes", () => {
  it("updates selection and prerequisite removal without recreating technology or preview images", () => {
    const ui = setup(technologyCode);
    ui.renderVote(summary);
    expect(ui.setText).toHaveBeenCalledWith('daily-tech-panel-count', '3');
    const buttons = ui.nodes["vote-options"].querySelectorAll(".vote-option");
    const preview = ui.nodes["vote-selection-preview"].children[0];
    const images = [...ui.images];
    ui.nodes["vote-options"].scrollTop = 180;
    buttons[1].click();
    expect([...ui.state.selections]).toEqual(["a", "b"]);
    expect(buttons.slice(0, 2).map(button => button.attributes["aria-pressed"])).toEqual(["true", "true"]);
    buttons[2].click(); // Still enforces the vote limit.
    expect([...ui.state.selections]).toEqual(["a", "b"]);
    buttons[0].click(); // Removing a prerequisite also removes its dependents.
    expect([...ui.state.selections]).toEqual([]);
    expect(buttons[1].dataset.selected).toBe("false");
    expect(ui.nodes["vote-options"].querySelectorAll(".vote-option")[1]).toBe(buttons[1]);
    expect(ui.nodes["vote-selection-preview"].children[0]).toBe(preview);
    expect(ui.nodes["vote-options"].scrollTop).toBe(180);
    expect(ui.images).toEqual(images);
  });

  it("reuses unchanged data but updates votes, language and participation permissions", () => {
    const ui = setup(technologyCode);
    ui.renderVote(summary);
    const button = ui.nodes["vote-options"].querySelectorAll(".vote-option")[0];
    ui.renderVote(structuredClone(summary));
    expect(ui.nodes["vote-options"].querySelectorAll(".vote-option")[0]).toBe(button);
    button.click();
    ui.state.dailyPanel = "technology";
    const changed = structuredClone(summary);
    changed.options[0].votes = 1;
    ui.renderVote(changed);
    expect(ui.nodes["vote-options"].querySelectorAll(".vote-count")[0].textContent).toBe("1 票");
    expect([...ui.state.selections]).toEqual(["a"]);
    expect(ui.state.dailyPanel).toBe("technology");
    expect(ui.nodes["vote-options"].querySelectorAll(".vote-option")[0].attributes["aria-pressed"]).toBe("true");
    const updated = ui.nodes["vote-options"].children[0];
    ui.environment.language = "ja";
    ui.renderVote(changed);
    expect(ui.nodes["vote-options"].children[0]).not.toBe(updated);
    ui.environment.technologyParticipated = true;
    ui.renderVote(changed);
    expect(ui.nodes["vote-options"].querySelectorAll(".vote-option").every(item => item.disabled)).toBe(true);
    expect(ui.nodes["submit-vote"].disabled).toBe(true);
  });

  it("keeps daily images and history while selecting, deselecting and navigating", () => {
    const ui = setup(dailyCode);
    ui.renderDailyVote(payload);
    const cards = [...ui.nodes["daily-vote-items"].children];
    const buttons = cards[0].querySelectorAll(".daily-vote-option");
    const images = [...ui.images];
    buttons[0].click();
    expect(ui.state.dailySelections.one).toEqual(["one-a"]);
    expect(buttons[0].attributes["aria-pressed"]).toBe("true");
    expect(buttons[0].className).toContain("is-selected");
    buttons[1].click();
    expect(ui.state.dailySelections.one).toEqual(["one-a"]);
    expect(ui.notice).toHaveBeenCalledTimes(1);
    buttons[0].click();
    expect(ui.state.dailySelections.one).toEqual([]);
    expect(buttons[0].attributes["aria-pressed"]).toBe("false");
    ui.openDailyPanel("items");
    expect(ui.panels.find(panel => panel.dataset.dailyPanelContent === "items").hidden).toBe(false);
    ui.backDailyPanels();
    ui.openDailyPanel("history");
    ui.renderDailyVote(structuredClone(payload));
    expect(ui.nodes["daily-vote-items"].children[0]).toBe(cards[0]);
    expect(ui.nodes["daily-vote-items"].children[1]).toBe(cards[1]);
    expect(ui.images).toEqual(images);
    expect(ui.history).toHaveBeenCalledTimes(1);
  });

  it("still updates daily totals and participant-list permissions when data changes", () => {
    const ui = setup(dailyCode);
    ui.renderDailyVote(payload);
    ui.nodes["daily-vote-items"].querySelectorAll(".daily-vote-option")[0].click();
    ui.state.dailyPanel = "items";
    const changed = structuredClone(payload);
    changed.items[0].options[0].votes = 3;
    ui.renderDailyVote(changed);
    expect(ui.nodes["daily-vote-items"].querySelectorAll(".daily-vote-option-count")[0].textContent).toBe("3 票");
    expect(ui.state.dailySelections.one).toEqual(["one-a"]);
    expect(ui.state.dailyPanel).toBe("items");
    expect(ui.nodes["daily-vote-items"].querySelectorAll(".daily-vote-option")[0].attributes["aria-pressed"]).toBe("true");
    ui.environment.dailyParticipated.add("one");
    ui.renderDailyVote(changed);
    const button = ui.nodes["daily-vote-items"].querySelectorAll(".daily-vote-option")[0];
    button.click();
    expect(ui.participants).toHaveBeenCalledWith(expect.objectContaining({ itemId: "one", optionId: "one-a", requiresIdentity: true }));
    expect(ui.state.dailySelections.one).toEqual(["one-a"]);
  });

  it("separates video preview from selection and allows previews after a poll closes", () => {
    const ui = setup(dailyCode);
    const media = structuredClone(payload);
    media.items[0].options[0].blocks.push({ type: "video", url: "https://example.com/clip.mp4" });
    ui.renderDailyVote(media);
    const option = ui.nodes["daily-vote-items"].querySelector(".daily-vote-option");
    expect(option.tagName).toBe("div");
    const action = option.querySelector(".daily-vote-option-select");
    const preview = option.querySelector(".rich-video-card");
    preview.click();
    expect(ui.state.dailySelections.one || []).toEqual([]);
    action.click();
    expect(ui.state.dailySelections.one).toEqual(["one-a"]);
    expect(action.attributes["aria-pressed"]).toBe("true");
    media.items[0].isOpen = false;
    ui.renderDailyVote(media);
    const closed = ui.nodes["daily-vote-items"].querySelector(".daily-vote-option");
    expect(closed.querySelector(".daily-vote-option-select").disabled).toBe(true);
    expect(closed.querySelector(".rich-video-card").disabled).not.toBe(true);
  });
});

describe('home vote feature count excludes history navigation', () => {
  const helper = source.slice(source.indexOf('  function dailyVoteFeatureCount('), source.indexOf('  function loadIdentitySession('));
  const count = runInNewContext(`${helper}\ndailyVoteFeatureCount`);
  it('shows the technology feature alone when there are no open items', () => {
    expect(count({ items: [] })).toBe(1);
    expect(count(undefined)).toBe(1);
  });
  it('adds each open item without counting the history entry or historical results', () => {
    expect(count({ items: [{}, {}], technologyHistory: [{}, {}], history: { polls: [{}, {}] } })).toBe(3);
  });
});
