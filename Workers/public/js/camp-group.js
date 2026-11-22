(() => {
  "use strict";

  function safeUrl(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    const source = value.trim();
    if (source.startsWith("/") && !source.startsWith("//") && !source.includes("\\")) {
      return source;
    }
    try {
      const url = new URL(source);
      return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
    } catch {
      return null;
    }
  }

  function inlineBlocks(source) {
    const blocks = [];
    const pattern = /(!?)\[([^\]]*)\]\((https:\/\/[^\s)]+|\/(?!\/)[^\s)]*)\)/g;
    let offset = 0;
    let match;
    while ((match = pattern.exec(source))) {
      if (match.index > offset) blocks.push({ type: "text", text: source.slice(offset, match.index) });
      const url = safeUrl(match[3]);
      if (!url) {
        blocks.push({ type: "text", text: match[0] });
      } else if (match[1] === "!") {
        blocks.push({ type: "image", src: url, alt: match[2] });
      } else {
        blocks.push({ type: "link", text: match[2] || url, url });
      }
      offset = pattern.lastIndex;
    }
    if (offset < source.length) blocks.push({ type: "text", text: source.slice(offset) });
    return blocks;
  }

  function fromMarkdown(value) {
    if (typeof value !== "string") throw new Error("Invalid camp group Markdown");
    const lines = value.replace(/\r\n?/g, "\n").split("\n");
    const blocks = [];
    let title = "";
    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (!line.trim()) {
        if (blocks.length && blocks.at(-1).type !== "br") blocks.push({ type: "br" });
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        const text = heading[2].trim();
        if (heading[1].length === 1 && !title) title = text;
        else blocks.push({ type: "heading", text });
      } else {
        blocks.push(...inlineBlocks(line));
      }
      if (blocks.length && blocks.at(-1).type !== "br") blocks.push({ type: "br" });
    }
    if (blocks.at(-1)?.type === "br") blocks.pop();
    return { title, blocks };
  }

  window.MrzhCampGroup = Object.freeze({ fromMarkdown });
})();
