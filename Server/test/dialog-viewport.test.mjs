import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../public/js/dialog-viewport.js", import.meta.url), "utf8");
function setup({ visualViewport = true, readyState = "complete" } = {}) {
  const classes = () => {
    const values = new Set();
    return { add: value => values.add(value), remove: value => values.delete(value), contains: value => values.has(value) };
  };
  const properties = {};
  const html = { classList: classes(), style: { setProperty: (key, value) => { properties[key] = value; } } };
  const body = { classList: classes() };
  const open = [], documentEvents = {}, viewportEvents = {}, windowEvents = {}, microtasks = [];
  let mutate;
  const document = { readyState, documentElement: html, body,
    querySelector: () => open.length ? open[open.length - 1] : null,
    addEventListener: (name, listener) => { documentEvents[name] = listener; } };
  const window = { innerHeight: 760, scrollX: 4, scrollY: 580,
    addEventListener: (name, listener) => { windowEvents[name] = listener; },
    visualViewport: visualViewport ? { height: 640.5, offsetTop: 0, addEventListener: (name, listener) => { viewportEvents[name] = listener; } } : null };
  window.scrollTo = vi.fn(({ top, left }) => { window.scrollY = top; window.scrollX = left; });
  runInNewContext(source, { document, window, queueMicrotask: callback => microtasks.push(callback),
    MutationObserver: class { constructor(listener) { mutate = listener; } observe() {} } });
  const flush = () => { while (microtasks.length) microtasks.shift()(); mutate?.(); };
  const beforeOpen = () => documentEvents.beforetoggle?.({ target: { tagName: "DIALOG" }, newState: "open" });
  const api = window.MrzhDialogViewport;
  return { html, body, open, window, properties, documentEvents, viewportEvents, windowEvents, api, flush, beforeOpen };
}

describe("dialogs stay in the visible viewport and lock the underlying page", () => {
  it("locks before focus can move the page, retains the original position, and restores it after close", () => {
    const ui = setup();
    ui.beforeOpen();
    expect(ui.body.classList.contains("dialog-viewport-open")).toBe(true);
    expect(ui.properties["--dialog-page-top"]).toBe("-580px");
    expect(ui.properties["--dialog-page-left"]).toBe("-4px");
    ui.window.scrollY = 0;
    ui.open.push({}); ui.flush();
    expect(ui.properties["--dialog-page-top"]).toBe("-580px");
    ui.open.pop(); ui.flush();
    expect(ui.window.scrollTo).toHaveBeenCalledExactlyOnceWith({ left: 4, top: 580, behavior: "instant" });
    expect(ui.body.classList.contains("dialog-viewport-open")).toBe(false);
    expect(ui.html.classList.contains("dialog-viewport-open")).toBe(false);
  });

  it("keeps the page locked until all nested dialogs have closed, including dynamic notices", () => {
    const ui = setup();
    ui.open.push({ name: "feature" }); ui.flush();
    ui.window.scrollY = 0;
    ui.open.push({ name: "password" }, { name: "notice" }); ui.flush();
    ui.open.pop(); ui.flush();
    ui.open.pop(); ui.flush();
    expect(ui.window.scrollTo).not.toHaveBeenCalled();
    expect(ui.body.classList.contains("dialog-viewport-open")).toBe(true);
    ui.open.pop(); ui.flush();
    expect(ui.window.scrollY).toBe(580);
  });

  it("follows toolbar, keyboard and viewport pan changes without overwriting the saved home position", () => {
    const ui = setup(); ui.open.push({}); ui.flush();
    expect(ui.properties["--dialog-visible-height"]).toBe("640.5px");
    ui.window.visualViewport.height = 320.25;
    ui.window.visualViewport.offsetTop = 68;
    ui.viewportEvents.resize(); ui.viewportEvents.scroll();
    expect(ui.properties["--dialog-visible-height"]).toBe("320.25px");
    expect(ui.properties["--dialog-visible-top"]).toBe("68px");
    expect(ui.properties["--dialog-page-top"]).toBe("-580px");
    ui.open.pop(); ui.api.sync();
    expect(ui.window.scrollY).toBe(580);
  });

  it("supports older WebViews without visualViewport or beforetoggle, including removal of a dialog", () => {
    const ui = setup({ visualViewport: false });
    ui.open.push({}); ui.flush();
    expect(ui.properties["--dialog-visible-height"]).toBe("760px");
    ui.window.innerHeight = 480; ui.windowEvents.resize();
    expect(ui.properties["--dialog-visible-height"]).toBe("480px");
    ui.open.splice(0); ui.flush();
    expect(ui.window.scrollY).toBe(580);
  });

  it("unlocks if opening is canceled, and does not unlock between synchronous dialog replacements", () => {
    const ui = setup(); ui.beforeOpen(); ui.flush();
    expect(ui.body.classList.contains("dialog-viewport-open")).toBe(false);
    ui.open.push({}); ui.flush();
    ui.open.pop(); ui.open.push({}); ui.flush();
    expect(ui.body.classList.contains("dialog-viewport-open")).toBe(true);
    expect(ui.window.scrollTo).toHaveBeenCalledTimes(1);
  });

  it("waits for the body to be ready when loaded in the document head", () => {
    const ui = setup({ readyState: "loading" });
    ui.open.push({});
    expect(ui.body.classList.contains("dialog-viewport-open")).toBe(false);
    ui.documentEvents.DOMContentLoaded();
    expect(ui.body.classList.contains("dialog-viewport-open")).toBe(true);
  });
});
