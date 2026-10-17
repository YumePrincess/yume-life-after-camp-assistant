(() => {
  const LIBRARY_URL = "https://oss.yume.zone/mini-program/library/data.json";
  const MAX_LIBRARY_BYTES = 512 * 1024;

  function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  }

  function httpsUrl(value) {
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
    } catch {
      return null;
    }
  }

  function isSimplifiedChinese(value) {
    if (typeof value !== "string") return false;
    const locale = value.trim().toLowerCase().replaceAll("_", "-");
    return ["zh", "zh-cn", "zh-sg", "zh-my", "zh-hans", "simplified", "simplified-chinese",
      "简体", "簡體", "简体中文", "簡體中文"].includes(locale) || locale.startsWith("zh-hans-");
  }

  function fromLibrary(payload) {
    const entries = record(payload)?.entries;
    if (!Array.isArray(entries)) throw new Error("Invalid camp group library");
    const entry = entries.map(record).find(item => item?.id === "life_after" &&
      (Array.isArray(item.languages) ? item.languages : [item.languages]).some(isSimplifiedChinese));
    if (!entry) return null;
    if (!Array.isArray(entry.blocks)) throw new Error("Invalid camp group blocks");
    const blocks = [];
    for (const raw of entry.blocks) {
      const block = record(raw);
      if (!block) continue;
      if (block.type === "text" && typeof block.text === "string") {
        blocks.push({ type: "text", text: block.text });
      } else if (block.type === "br") {
        blocks.push({ type: "br" });
      } else if (block.type === "link" && typeof block.text === "string") {
        const url = httpsUrl(block.url);
        if (url) blocks.push({ type: "link", text: block.text, url });
      } else if (block.type === "image") {
        const src = httpsUrl(block.src);
        if (src) blocks.push({ type: "image", src, alt: typeof block.alt === "string" ? block.alt : "" });
      }
    }
    return { title: typeof entry.title === "string" ? entry.title : "", blocks };
  }

  async function load() {
    // Use the mini-program's source directly, without sending identity credentials.
    const upstream = await fetch(`${LIBRARY_URL}?t=${Date.now()}`, {
      headers: { Accept: "application/json" },
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000)
    });
    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel();
      throw new Error("Camp group library unavailable");
    }
    const reader = upstream.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_LIBRARY_BYTES) {
          await reader.cancel();
          throw new Error("Camp group library exceeds size limit");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return fromLibrary(JSON.parse(new TextDecoder().decode(bytes)));
  }

  window.MrzhCampGroup = Object.freeze({ fromLibrary, load });
})();
