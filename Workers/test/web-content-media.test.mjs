import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
const read = file => readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8");
const admin = read("js/admin.js");
const parserCode = admin.slice(admin.indexOf("  function publicHighlightBlocks("), admin.indexOf("  function capturePublicContentDraft("));
const parser = runInNewContext(`${parserCode}\n({parsePublicHighlights, serializePublicHighlights})`);
class Element {
  constructor(tag) {
    Object.assign(this, { tagName: tag, children: [], attributes: {}, events: {}, dataset: {}, className: "" });
    const properties = new Map();
    this.style = {
      setProperty: (name, value) => properties.set(name, value),
      getPropertyValue: name => properties.get(name) || "",
      removeProperty: name => properties.delete(name)
    };
  }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; delete this[key]; }
  addEventListener(key, value) { this.events[key] = value; }
  showModal() { this.open = true; }
  close() { this.open = false; this.events.close?.(); }
  load = vi.fn(); pause = vi.fn(); play = vi.fn(() => Promise.resolve());
}
function setupMedia() {
  const nodes = [], events = {}, body = new Element("body");
  const window = { MrzhI18n: { t: text => text }, addEventListener: (key, fn) => { events[key] = fn; } };
  runInNewContext(read("js/content-media.js"), { window, URL, document: { body, createElement: tag => { const node = new Element(tag); nodes.push(node); return node; } } });
  return { api: window.MrzhContentMedia, nodes, body, events };
}
describe("rich content editor", () => {
  it("round-trips images, direct videos, extensionless videos and surrounding text", () => {
    const text = "开始\n![图片](https://example.com/p.jpg)\n@[视频](https://example.com/play?id=1)\nhttps://example.com/clip.MP4?token=a#t=1\n结束\n\n第二条公告";
    const result = parser.parsePublicHighlights(text);
    expect(result[0].blocks.map(block => block.type)).toEqual(["text", "image", "video", "video", "text"]);
    expect(result).toHaveLength(2);
    expect(parser.parsePublicHighlights(parser.serializePublicHighlights(result))).toEqual(result);
    expect(parser.parsePublicHighlights("![旧格式](https://example.com/a.webm)")[0].blocks[0].type).toBe("video");
  });
  it("leaves ordinary links, unsupported protocols and video-platform pages as text", () => {
    for (const text of ["[链接](https://example.com/a.mp4)", "@[视频](http://example.com/a.mp4)", "https://example.com/watch?v=1", "文字 https://example.com/a.mp4"]) {
      expect(parser.parsePublicHighlights(text)[0].blocks).toEqual([{ type: "text", text }]);
    }
  });
});
describe("video preview lifecycle", () => {
  it.each([[1920, 1080], [1080, 1920], [1200, 1200], [2400, 600]])("fits a %i × %i video at its native ratio and resets between clips", (width, height) => {
    const ui = setupMedia();
    ui.api.open({ url: "https://example.com/a.mp4" });
    const dialog = ui.body.children[0];
    const player = ui.nodes.find(node => node.className === "video-preview-player");
    player.videoWidth = width;
    player.videoHeight = height;
    player.events.loadedmetadata();
    expect(Number(dialog.style.getPropertyValue("--media-aspect-ratio"))).toBe(width / height);
    player.videoWidth = height;
    player.videoHeight = width;
    player.events.resize();
    expect(Number(dialog.style.getPropertyValue("--media-aspect-ratio"))).toBe(height / width);
    ui.api.open({ url: "https://example.com/b.mp4" });
    expect(dialog.style.getPropertyValue("--media-aspect-ratio")).toBe("");
    player.videoWidth = 0;
    player.events.loadedmetadata();
    expect(dialog.style.getPropertyValue("--media-aspect-ratio")).toBe("");
    dialog.close();
    player.videoWidth = width;
    player.events.loadedmetadata();
    expect(dialog.style.getPropertyValue("--media-aspect-ratio")).toBe("");
  });
  it("opens native controls on a user click without selecting a poll option, and stops on close", () => {
    const ui = setupMedia();
    const card = ui.api.card({ type: "video", url: "https://example.com/a.mp4", alt: "视频" });
    const thumbnail = ui.nodes.find(node => node.tagName === "video");
    expect(thumbnail.muted).toBe(true);
    expect(thumbnail.play).not.toHaveBeenCalled();
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    card.events.click(event);
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    const dialog = ui.body.children[0];
    const player = ui.nodes.find(node => node.className === "video-preview-player");
    expect(dialog.open).toBe(true);
    expect(player.controls).toBe(true);
    expect(player.playsInline).toBe(true);
    expect(player.play).toHaveBeenCalledOnce();
    dialog.close();
    expect(player.pause).toHaveBeenCalledTimes(2);
    expect(player.src).toBeUndefined();
    expect(player.load).toHaveBeenCalledTimes(2);
    ui.api.open({ type: "video", url: "https://example.com/b.webm" });
    expect(ui.body.children).toHaveLength(1);
    expect(player.src).toBe("https://example.com/b.webm");
    player.events.error();
    expect(ui.nodes.find(node => node.className === "video-preview-error").hidden).toBe(false);
    ui.events.pagehide();
    expect(dialog.open).toBe(false);
    expect(player.src).toBeUndefined();
  });
  it("never creates a player for unsafe or credential-bearing URLs", () => {
    const ui = setupMedia();
    for (const url of ["http://example.com/a.mp4", "https://user:secret@example.com/a.mp4", "javascript:alert(1)"]) {
      expect(ui.api.card({ url })).toBeNull(); ui.api.open({ url });
    }
    expect(ui.body.children).toHaveLength(0);
  });
});
describe("shared editing help", () => {
  it("opens existing modals with localized instructions for every admin help topic", () => {
    const i18n = read("js/i18n.js");
    const dictionaries = runInNewContext(i18n.slice(i18n.indexOf("  const translations ="), i18n.indexOf("  function translate(")) + "\ntranslations");
    const html = read("admin.html");
    const topics = [...html.matchAll(/data-editing-help="([^"]+)"/g)].map(match => match[1]);
    topics.push("interval");
    let handler;
    const show = vi.fn();
    let language = "en";
    const window = { MrzhI18n: { t: text => dictionaries[language][text] || text } };
    runInNewContext(read("js/editing-help.js"), { window, document: { addEventListener: (_, fn) => { handler = fn; } } });
    window.MrzhEditingHelp.install(show);
    for (language of ["en", "fr", "ja", "zh-tw"]) {
      for (const topic of topics) {
        handler({ target: { closest: () => ({ dataset: { editingHelp: topic } }) }, preventDefault() {} });
        const [body, options] = show.mock.calls.at(-1);
        expect(body.length).toBeGreaterThan(10);
        expect(options.title).toBe("编辑说明");
        if (["rich", "highlights", "options"].includes(topic)) {
          expect(body).toContain("!["); expect(body).toContain("@["); expect(body).toContain("16:10"); expect(body).toContain("HTTPS");
        }
        // All source paragraphs must translate, including the older policy guidance.
        for (const match of read("js/editing-help.js").matchAll(/"([^"\n]*[\u4e00-\u9fff][^"\n]*)"/g)) {
          if (match[1] !== "编辑说明") expect(body).not.toContain(match[1]);
        }
      }
    }
    expect(html).not.toContain("图片单独占一行");
    expect(html).not.toContain("支持文本和 Markdown 图片");
    expect(topics).toContain("highlights"); expect(topics).toContain("options");
  });
});
