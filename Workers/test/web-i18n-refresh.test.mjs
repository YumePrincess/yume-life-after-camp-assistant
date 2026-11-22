import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../public/js/i18n.js", import.meta.url), "utf8");

function setup() {
  let language = "zh-cn";
  const documentEvents = {};
  const windowEvents = {};
  const dispatchEvent = vi.fn();
  const textWrite = vi.fn();
  let value = "未登录";
  const textNode = {
    parentElement: { closest: () => false, tagName: "SPAN" },
    get nodeValue() { return value; },
    set nodeValue(next) { textWrite(next); value = next; }
  };
  const nodes = [textNode];
  const attributes = { alt: "头像" };
  const attributeWrite = vi.fn();
  const image = {
    hasAttribute: key => key in attributes,
    getAttribute: key => attributes[key],
    setAttribute(key, next) { attributeWrite(key, next); attributes[key] = next; }
  };
  const document = {
    title: "明日之后“雨梦庭”营地助手", documentElement: { dataset: {} }, body: {},
    createTreeWalker() { let index = 0; return { nextNode: () => nodes[index++] }; },
    querySelectorAll: selector => selector === "[aria-label], [title], [alt]" ? [image] : [],
    querySelector: () => null,
    addEventListener(name, callback) { documentEvents[name] = callback; }, dispatchEvent
  };
  const window = {
    YumePreferences: {
      getLanguageChoice: () => language, resolveLanguage: value => value,
      getThemeChoice: () => "dark", applyTheme: vi.fn()
    },
    MrzhTimezone: { parts: () => ({ year: "2026" }) },
    addEventListener(name, callback) { windowEvents[name] = callback; }
  };
  runInNewContext(source, {
    document, window, NodeFilter: { SHOW_TEXT: 4 },
    MutationObserver: class { observe() {} },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } }
  });
  documentEvents.DOMContentLoaded();
  return { window, windowEvents, dispatchEvent, textWrite, attributeWrite, nodes, setLanguage: next => { language = next; } };
}

describe("ordinary focus does not reload locale-specific page data", () => {
  it("does not re-emit language changes or rewrite unchanged image attributes on focus and theme events", () => {
    const ui = setup();
    expect(ui.dispatchEvent).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 3; index++) ui.windowEvents.focus();
    ui.windowEvents["yume:preferenceschange"]();
    ui.window.MrzhI18n.apply({ emitEvent: false });
    expect(ui.dispatchEvent).toHaveBeenCalledTimes(1);
    expect(ui.textWrite).not.toHaveBeenCalled();
    expect(ui.attributeWrite).not.toHaveBeenCalled();
  });

  it.each(["zh-tw", "en", "fr", "ja"])("emits once for a real switch to %s and translates new content without another refresh", language => {
    const ui = setup();
    ui.setLanguage(language);
    ui.windowEvents.focus();
    expect(ui.dispatchEvent).toHaveBeenCalledTimes(2);
    expect(ui.dispatchEvent.mock.calls[1][0].detail.language).toBe(language);
    const text = { nodeValue: "未登录", parentElement: { tagName: "SPAN", closest: () => false } };
    ui.nodes.push(text);
    ui.window.MrzhI18n.apply({ emitEvent: false });
    expect(text.nodeValue).toBe(ui.window.MrzhI18n.t("未登录"));
    ui.windowEvents["yume:preferenceschange"]();
    ui.windowEvents.focus();
    expect(ui.dispatchEvent).toHaveBeenCalledTimes(2);
  });

  it("preserves a shared-cookie language notification if a DOM translation pass ran first", () => {
    const ui = setup();
    ui.setLanguage("ja");
    ui.window.MrzhI18n.apply({ emitEvent: false });
    expect(ui.dispatchEvent).toHaveBeenCalledTimes(1);
    ui.windowEvents.focus();
    expect(ui.dispatchEvent).toHaveBeenCalledTimes(2);
  });
});
