import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

interface Context {
  identityCode: string;
  password: string;
  scopeKey: string;
  revision: number;
}
interface ParticipationSyncOptions {
  getContext(): Context | null;
  request(context: Context): Promise<unknown>;
  apply(result: unknown, context: Context): void;
  onError?(error: unknown): void;
  now?(): number;
  maxAgeMs?: number;
}
const browser: { MrzhVoteParticipation?: {
  create(options: ParticipationSyncOptions): { refresh(options?: { force?: boolean }): Promise<boolean> };
} } = {};

beforeAll(async () => {
  vi.stubGlobal("window", browser);
  const browserModule = "../public/js/vote-participation.js";
  await import(browserModule);
});
afterAll(() => vi.unstubAllGlobals());

function deferred() {
  let resolve!: (result: unknown) => void;
  const promise = new Promise<unknown>(done => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  const context: { value: Context | null } = {
    value: { identityCode: "99990000", password: "test-only", scopeKey: "poll-and-draw", revision: 0 }
  };
  const apply = vi.fn();
  const onError = vi.fn();
  const request = vi.fn<(context: Context) => Promise<unknown>>();
  let clock = 0;
  const sync = browser.MrzhVoteParticipation!.create({
    getContext: () => context.value,
    request,
    apply,
    onError,
    now: () => clock
  });
  return { context, apply, onError, request, sync, advance: (ms: number) => { clock += ms; } };
}

const participated = {
  technologyParticipated: true,
  dailyParticipatedItemIds: ["poll", "draw"]
};

describe("web participation status synchronization", () => {
  it("waits for bootstrap and credentials before checking existing votes and draws", async () => {
    const h = setup();
    const ready = h.context.value;
    h.context.value = null;
    expect(await h.sync.refresh()).toBe(false);
    expect(h.request).not.toHaveBeenCalled();
    h.context.value = ready;
    h.request.mockResolvedValue(participated);
    expect(await h.sync.refresh()).toBe(true);
    expect(h.apply).toHaveBeenCalledWith(participated, ready);
  });

  it("rechecks cached non-participation after its freshness interval", async () => {
    const h = setup();
    h.request.mockResolvedValueOnce({ dailyParticipatedItemIds: [] }).mockResolvedValue(participated);
    await h.sync.refresh();
    await h.sync.refresh();
    expect(h.request).toHaveBeenCalledTimes(1);
    h.advance(30_000);
    await h.sync.refresh();
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.apply).toHaveBeenLastCalledWith(participated, h.context.value);
  });

  it("rechecks on panel entry even when a non-participation result is still fresh", async () => {
    const h = setup();
    h.request.mockResolvedValueOnce({ dailyParticipatedItemIds: [] }).mockResolvedValue(participated);
    await h.sync.refresh();
    await h.sync.refresh({ force: true });
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.apply).toHaveBeenLastCalledWith(participated, h.context.value);
  });

  it("queues a changed voting scope during an ordinary in-flight refresh", async () => {
    const h = setup();
    const first = deferred();
    h.request.mockImplementationOnce(() => first.promise).mockResolvedValue(participated);
    const pending = h.sync.refresh();
    h.context.value = { ...h.context.value!, scopeKey: "new-poll-and-draw" };
    expect(h.sync.refresh()).toBe(pending);
    first.resolve({ dailyParticipatedItemIds: [] });
    await pending;
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.apply).toHaveBeenCalledExactlyOnceWith(participated, h.context.value);
  });

  it("retries a stale scope even if there is no second refresh call", async () => {
    const h = setup();
    const first = deferred();
    h.request.mockImplementationOnce(() => first.promise).mockResolvedValue(participated);
    const pending = h.sync.refresh();
    h.context.value = { ...h.context.value!, scopeKey: "next-period" };
    first.resolve({ dailyParticipatedItemIds: [] });
    await pending;
    expect(h.apply).toHaveBeenCalledExactlyOnceWith(participated, h.context.value);
  });

  it("does not let an older read overwrite a newly completed vote or draw", async () => {
    const h = setup();
    const first = deferred();
    h.request.mockImplementationOnce(() => first.promise).mockResolvedValue(participated);
    const pending = h.sync.refresh();
    h.context.value = { ...h.context.value!, revision: 1 };
    first.resolve({ technologyParticipated: false, dailyParticipatedItemIds: [] });
    await pending;
    expect(h.apply).toHaveBeenCalledExactlyOnceWith(participated, h.context.value);
  });

  it("discards an old account response and checks the new credentials", async () => {
    const h = setup();
    const first = deferred();
    h.request.mockImplementationOnce(() => first.promise).mockResolvedValue(participated);
    const pending = h.sync.refresh();
    h.context.value = { ...h.context.value!, identityCode: "99990001", password: "changed-test-only" };
    first.resolve({ dailyParticipatedItemIds: ["other-account"] });
    await pending;
    expect(h.request).toHaveBeenLastCalledWith(h.context.value);
    expect(h.apply).toHaveBeenCalledExactlyOnceWith(participated, h.context.value);
  });

  it("does not apply a pending response after logout", async () => {
    const h = setup();
    const first = deferred();
    h.request.mockImplementationOnce(() => first.promise);
    const pending = h.sync.refresh();
    h.context.value = null;
    first.resolve(participated);
    expect(await pending).toBe(false);
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it("coalesces simultaneous forced checks into one trailing query", async () => {
    const h = setup();
    const first = deferred();
    h.request.mockImplementationOnce(() => first.promise).mockResolvedValue(participated);
    const pending = h.sync.refresh();
    h.sync.refresh({ force: true });
    h.sync.refresh({ force: true });
    first.resolve(participated);
    await pending;
    expect(h.request).toHaveBeenCalledTimes(2);
  });

  it("does not cache errors or preserve a fresh cache after a failed forced check", async () => {
    const h = setup();
    const error = new Error("temporary failure");
    h.request.mockResolvedValueOnce({ dailyParticipatedItemIds: [] })
      .mockRejectedValueOnce(error).mockResolvedValue(participated);
    await h.sync.refresh();
    expect(await h.sync.refresh({ force: true })).toBe(false);
    expect(h.onError).toHaveBeenCalledWith(error);
    expect(await h.sync.refresh()).toBe(true);
    expect(h.request).toHaveBeenCalledTimes(3);
    expect(h.apply).toHaveBeenLastCalledWith(participated, h.context.value);
  });
});
