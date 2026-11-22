import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withSecurityHeaders } from "../src/response";
import { DEFAULT_CAMP_GROUP_MARKDOWN } from "../src/validate";

interface CampGroup { title: string; blocks: Array<Record<string, string>> }
const browser: { MrzhCampGroup?: { fromMarkdown(value: unknown): CampGroup } } = {};

beforeAll(async () => {
  vi.stubGlobal("window", browser);
  const browserModule: string = "../public/js/camp-group.js";
  await import(browserModule);
});

afterEach(() => vi.unstubAllGlobals());

describe("camp group Markdown", () => {
  it("provides editable default content with QR placeholders hosted by this site", () => {
    expect(DEFAULT_CAMP_GROUP_MARKDOWN).toContain("![QQ群二维码](/images/camp-groups/qq.png)");
    expect(DEFAULT_CAMP_GROUP_MARKDOWN).toContain("![微信群二维码](/images/camp-groups/wx.png)");
    expect(DEFAULT_CAMP_GROUP_MARKDOWN).not.toContain("data.json");
    expect(DEFAULT_CAMP_GROUP_MARKDOWN).not.toContain("yume.zone");
  });

  it("renders headings, text, line breaks, external image URLs, and local assets from Markdown", () => {
    const markdown = [
      "# 雨梦庭营地交流群",
      "",
      "请扫描以下二维码加入营地群。",
      "进入营地群后修改名片。",
      "",
      "QQ群：",
      "",
      "![QQ群二维码](/images/camp-groups/qq.png)",
      "",
      "微信群：",
      "",
      "![微信群二维码](https://example.com/images/camp-groups/wx.png)",
      "",
      "[营地介绍](https://example.com/camp)"
    ].join("\n");

    const result = browser.MrzhCampGroup!.fromMarkdown(markdown);
    expect(result.title).toBe("雨梦庭营地交流群");
    expect(result.blocks).toContainEqual({ type: "image", src: "/images/camp-groups/qq.png", alt: "QQ群二维码" });
    expect(result.blocks).toContainEqual({ type: "image", src: "https://example.com/images/camp-groups/wx.png", alt: "微信群二维码" });
    expect(result.blocks).toContainEqual({ type: "link", text: "营地介绍", url: "https://example.com/camp" });
    expect(result.blocks.some(block => block.type === "br")).toBe(true);
  });

  it("keeps unsafe Markdown image and link targets as plain text", () => {
    const result = browser.MrzhCampGroup!.fromMarkdown([
      "![script](javascript:alert(1))",
      "![credentials](https://name:password@example.com/image.png)",
      "[insecure](http://example.com/camp)"
    ].join("\n"));
    expect(result.blocks.some(block => block.type === "image" || block.type === "link")).toBe(false);
    expect(result.blocks.some(block => block.type === "text" && block.text?.includes("javascript:"))).toBe(true);
  });

  it("parses content locally without fetching a URL", () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(browser.MrzhCampGroup!.fromMarkdown("![img](https://example.com/image.png)").blocks)
      .toContainEqual({ type: "image", src: "https://example.com/image.png", alt: "img" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps remote resources in image-src without allowing cross-origin API calls", () => {
    const csp = withSecurityHeaders(new Response()).headers.get("Content-Security-Policy") || "";
    expect(csp).toContain("img-src 'self' data: blob: https:");
    expect(csp.split(";").find(value => value.trim().startsWith("connect-src"))?.trim())
      .toBe("connect-src 'self'");
  });

  it("rejects non-text content", () => {
    expect(() => browser.MrzhCampGroup!.fromMarkdown({})).toThrow("Invalid camp group Markdown");
  });
});
