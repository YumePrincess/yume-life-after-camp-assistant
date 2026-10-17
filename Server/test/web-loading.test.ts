import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const browser: { MrzhLoading?: {
  createTracker(weights: Record<string, number>, progress: (value: number) => void, complete: () => void): { settle(name: string): void };
} } = {};
beforeAll(async () => {
  vi.stubGlobal("window", browser);
  const browserModule = "../public/js/loading.js";
  await import(browserModule);
});
afterAll(() => vi.unstubAllGlobals());

describe("page loading resource completion", () => {
  function setup() {
    const progress = vi.fn();
    const complete = vi.fn();
    const tracker = browser.MrzhLoading!.createTracker({ document: 15, fonts: 10, background: 15, data: 35, group: 15, identity: 10 }, progress, complete);
    return { tracker, progress, complete };
  }

  it("does not complete after data alone while images, fonts and group data are pending", () => {
    const h = setup();
    h.tracker.settle("data");
    expect(h.progress).toHaveBeenLastCalledWith(35);
    expect(h.complete).not.toHaveBeenCalled();
  });

  it("tracks settled resources in any order and completes only when all are ready", () => {
    const h = setup();
    for (const name of ["group", "data", "identity", "document", "background"]) h.tracker.settle(name);
    expect(h.progress).toHaveBeenLastCalledWith(90);
    expect(h.complete).not.toHaveBeenCalled();
    h.tracker.settle("fonts");
    expect(h.progress).toHaveBeenLastCalledWith(100);
    expect(h.complete).toHaveBeenCalledTimes(1);
  });

  it("does not count repeated render or live refresh completions twice", () => {
    const h = setup();
    h.tracker.settle("data");
    h.tracker.settle("data");
    h.tracker.settle("unknown");
    expect(h.progress).toHaveBeenCalledExactlyOnceWith(35);
    expect(h.complete).not.toHaveBeenCalled();
  });

  it("allows a failed resource to settle after its fallback is rendered", () => {
    const h = setup();
    for (const name of ["document", "fonts", "background", "data", "identity"]) h.tracker.settle(name);
    expect(h.complete).not.toHaveBeenCalled();
    // The group fetch error path renders its existing retry UI, then settles.
    h.tracker.settle("group");
    expect(h.complete).toHaveBeenCalledTimes(1);
    h.tracker.settle("group");
    expect(h.complete).toHaveBeenCalledTimes(1);
  });

  it("supports login and admin tasks without waiting for public-only resources", () => {
    const complete = vi.fn();
    const tracker = browser.MrzhLoading!.createTracker({ document: 20, fonts: 10, background: 20, data: 50 }, vi.fn(), complete);
    for (const name of ["document", "fonts", "background", "data"]) tracker.settle(name);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
