import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withSecurityHeaders } from "../src/response";

interface CampGroup { title: string; blocks: unknown[] }
interface CampGroupHelpers {
  fromLibrary(value: unknown): CampGroup | null;
  load(): Promise<CampGroup | null>;
}
const browser: { MrzhCampGroup?: CampGroupHelpers } = {};
beforeAll(async () => {
  vi.stubGlobal("window", browser);
  const browserModule = "../public/js/camp-group.js";
  await import(browserModule);
});
function campGroupFromLibrary(value: unknown) {
  return browser.MrzhCampGroup!.fromLibrary(value);
}
function loadCampGroup() {
  return browser.MrzhCampGroup!.load();
}

const entry = {
  id: "life_after", languages: ["zh-cn"], title: "营地群",
  blocks: [
    { type: "text", text: "请扫码加入" },
    { type: "br" },
    { type: "image", src: "https://oss.yume.zone/group.png" },
    { type: "link", text: "群资料", url: "https://www.yume.zone/group" }
  ]
};

afterEach(() => vi.unstubAllGlobals());

describe("shared mini-program camp group", () => {
  it("selects the Simplified Chinese life_after entry and preserves its blocks", () => {
    expect(campGroupFromLibrary({ entries: [
      { ...entry, id: "other" },
      { ...entry, languages: ["en"], title: "English" },
      entry
    ] })).toEqual({
      title: "营地群",
      blocks: [entry.blocks[0], entry.blocks[1], { ...entry.blocks[2], alt: "" }, entry.blocks[3]]
    });
  });

  it("matches mini-program language aliases and ignores undeclared entries", () => {
    expect(campGroupFromLibrary({ entries: [{ ...entry, languages: "简体中文" }] })?.title).toBe("营地群");
    expect(campGroupFromLibrary({ entries: [{ ...entry, languages: undefined }] })).toBeNull();
    expect(campGroupFromLibrary({ entries: [] })).toBeNull();
  });

  it("omits executable URLs, credentials and unknown block types", () => {
    expect(campGroupFromLibrary({ entries: [{ ...entry, blocks: [
      { type: "link", text: "unsafe", url: "javascript:alert(1)" },
      { type: "image", src: "data:image/svg+xml,unsafe" },
      { type: "image", src: "https://name:password@example.com/image" },
      { type: "html", text: "<script>" },
      { type: "text", text: "<script> stays plain text" }
    ] }] })?.blocks).toEqual([{ type: "text", text: "<script> stays plain text" }]);
  });

  it("rejects malformed library payloads", () => {
    expect(() => campGroupFromLibrary({})).toThrow("Invalid camp group library");
    expect(() => campGroupFromLibrary({ entries: [{ ...entry, blocks: null }] })).toThrow("Invalid camp group blocks");
  });

  it("fetches the mini-program source directly without identity credentials", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ entries: [entry] })));
    vi.stubGlobal("fetch", fetcher);
    expect((await loadCampGroup())?.title).toBe("营地群");
    expect(fetcher).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/oss\.yume\.zone\/mini-program\/library\/data\.json\?t=\d+$/), expect.objectContaining({
      redirect: "error", signal: expect.any(AbortSignal), credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store"
    }));
  });

  it("allows only the shared library path in the page connection policy", () => {
    const csp = withSecurityHeaders(new Response()).headers.get("Content-Security-Policy");
    expect(csp?.split(";").find(value => value.trim().startsWith("connect-src"))?.trim())
      .toBe("connect-src 'self' https://oss.yume.zone/mini-program/library/data.json");
  });

  it("rejects upstream failure and oversized streamed responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Unavailable", { status: 503 })));
    await expect(loadCampGroup()).rejects.toThrow("unavailable");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(512 * 1024 + 1))));
    await expect(loadCampGroup()).rejects.toThrow("size limit");
  });
});
