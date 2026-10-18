import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../public/js/mobile-viewport.js", import.meta.url), "utf8");
function setup({ fixed = true, supportsOverscroll = false } = {}) {
  const listeners = new Map();
  class Element {
    constructor(options = {}) {
      Object.assign(this, {
        parentElement: null, scrollTop: 0, scrollLeft: 0,
        scrollHeight: 200, clientHeight: 200, scrollWidth: 200, clientWidth: 200,
        style: { overflowX: "visible", overflowY: "visible", touchAction: "auto" },
      }, options);
    }
  }
  const root = { style: {} };
  vm.runInNewContext(source, {
    document: {
      documentElement: root,
      body: { hasAttribute: () => fixed },
      addEventListener(name, callback) {
        listeners.set(name, [...(listeners.get(name) || []), callback]);
      },
    },
    window: { CSS: { supports: () => supportsOverscroll } },
    Element,
    getComputedStyle: (element) => element.style,
  });
  function event(name, { touches = [{ clientX: 40, clientY: 100 }], target, cancelable = true } = {}) {
    const result = { touches, target, cancelable, prevented: false, preventDefault() { this.prevented = true; } };
    for (const callback of listeners.get(name) || []) callback(result);
    return result;
  }
  function drag(target, x = 40, y = 80) {
    event("touchstart");
    return event("touchmove", { target, touches: [{ clientX: x, clientY: y }] });
  }
  return { Element, event, drag, root };
}

describe("mobile zoom and fixed chat scrolling", () => {
  it("blocks pinch gestures and multi-touch page zoom, preserving single-finger home scrolling", () => {
    const h = setup({ fixed: false });
    expect(h.root.style.touchAction).toBe("pan-x pan-y");
    expect(h.event("gesturestart").prevented).toBe(true);
    expect(h.event("gesturechange").prevented).toBe(true);
    expect(h.event("touchmove", { touches: [{}, {}] }).prevented).toBe(true);
    expect(h.drag(new h.Element()).prevented).toBe(false);
    expect(h.event("gesturestart", { cancelable: false }).prevented).toBe(false);
  });

  it("prevents dragging a short conversation list or empty chat canvas in older WebViews", () => {
    const h = setup();
    expect(h.drag(new h.Element()).prevented).toBe(true);
    expect(h.drag(new h.Element({ style: { overflowY: "auto" } })).prevented).toBe(true);
  });

  it("lets overflowing messages and contacts scroll, while stopping page bounce at either boundary", () => {
    const h = setup();
    const list = new h.Element({ scrollHeight: 900, scrollTop: 100, style: { overflowY: "auto" } });
    expect(h.drag(list).prevented).toBe(false);
    list.scrollTop = 0;
    expect(h.drag(list, 40, 120).prevented).toBe(true);
    expect(h.drag(list, 40, 80).prevented).toBe(false);
    list.scrollTop = 700;
    expect(h.drag(list, 40, 80).prevented).toBe(true);
    expect(h.drag(list, 40, 120).prevented).toBe(false);
  });

  it("allows a scrollable parent when a nested pane reaches its boundary", () => {
    const h = setup();
    const parent = new h.Element({ scrollHeight: 900, scrollTop: 100, style: { overflowY: "auto" } });
    const child = new h.Element({ parentElement: parent });
    expect(h.drag(child).prevented).toBe(false);
  });

  it("preserves horizontal code/table scrolling and custom drag controls", () => {
    const h = setup();
    const code = new h.Element({ scrollWidth: 600, style: { overflowX: "auto" } });
    expect(h.drag(code, 20, 100).prevented).toBe(false);
    expect(h.drag(code, 60, 100).prevented).toBe(true);
    expect(h.drag(new h.Element({ style: { touchAction: "none" } })).prevented).toBe(false);
  });

  it("uses native overscroll containment when supported, while still rejecting pinch zoom", () => {
    const h = setup({ supportsOverscroll: true });
    expect(h.drag(new h.Element()).prevented).toBe(false);
    expect(h.event("touchmove", { touches: [{}, {}] }).prevented).toBe(true);
  });
});
