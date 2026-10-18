import { describe, expect, it } from "vitest";
import { validatePublicOverview } from "../src/validate";
import { normalizeDailyVoteInput } from "../src/daily-vote";
import { withSecurityHeaders } from "../src/response";
const blocks = [
  { type: "text", text: "活动说明" },
  { type: "image", url: "https://example.com/poster.jpg", alt: "海报" },
  { type: "video", url: "https://example.com/play?id=one", alt: "活动视频" },
  { type: "text", text: "结束" }
];
const poll = () => ({
  kind: "poll", localizedContent: {
    "zh-cn": { titleBlocks: blocks, descriptionBlocks: blocks, options: [
      { id: "a", blocks }, { id: "b", blocks: [{ type: "text", text: "B" }] }
    ] },
    ja: { titleBlocks: blocks, descriptionBlocks: [], options: [
      { id: "a", blocks }, { id: "b", blocks: [{ type: "text", text: "B" }] }
    ] }
  }, startAt: "2026-10-18T00:00:00Z", endAt: "2026-10-20T00:00:00Z", maxSelections: 1
});
describe("direct video content validation", () => {
  it("keeps mixed media order in localized announcements and JSON round trips", () => {
    const overview = validatePublicOverview({ announcement: "公告", highlights: [{ blocks }] });
    expect(overview.highlights[0]?.blocks).toEqual(blocks);
    expect(overview.localized.ja.highlights[0]?.blocks).toEqual(blocks);
    expect(validatePublicOverview(JSON.parse(JSON.stringify(overview)))).toEqual(overview);
  });
  it("accepts videos in localized poll titles, descriptions and options", () => {
    const normalized = normalizeDailyVoteInput(poll());
    expect(normalized.localizedContent["zh-cn"]?.titleBlocks).toEqual(blocks);
    expect(normalized.localizedContent["zh-cn"]?.descriptionBlocks).toEqual(blocks);
    expect(normalized.localizedContent.ja?.options[0]?.blocks).toEqual(blocks);
    expect(normalizeDailyVoteInput(JSON.parse(JSON.stringify(normalized)))).toEqual(normalized);
  });
  it.each(["http://example.com/a.mp4", "javascript:alert(1)", "data:video/mp4;base64,AAAA", "https://user:secret@example.com/a.mp4"])("rejects unsafe video URL %s in both content types", url => {
    expect(() => validatePublicOverview({ announcement: "", highlights: [{ blocks: [{ type: "video", url }] }] })).toThrow("HTTPS URL");
    const input = poll();
    input.localizedContent["zh-cn"].titleBlocks = [{ type: "video", url, alt: "视频" }];
    expect(() => normalizeDailyVoteInput(input)).toThrow("HTTPS URL");
  });
  it("permits HTTPS native media without widening the script policy", () => {
    const csp = withSecurityHeaders(new Response()).headers.get("Content-Security-Policy");
    expect(csp).toContain("media-src 'self' https:");
    expect(csp).toContain("script-src 'self';");
    expect(csp).not.toContain("unsafe-inline");
  });
});
