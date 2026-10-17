export type CampGroupBlock =
  | { type: "text"; text: string }
  | { type: "link"; text: string; url: string }
  | { type: "br" }
  | { type: "image"; src: string; alt: string };

export interface CampGroupEntry {
  title: string;
  blocks: CampGroupBlock[];
}

const LIBRARY_URL = "https://oss.yume.zone/mini-program/library/data.json";
const MAX_LIBRARY_BYTES = 512 * 1024;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function isSimplifiedChinese(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const locale = value.trim().toLowerCase().replaceAll("_", "-");
  return ["zh", "zh-cn", "zh-sg", "zh-my", "zh-hans", "simplified", "simplified-chinese",
    "简体", "簡體", "简体中文", "簡體中文"].includes(locale) || locale.startsWith("zh-hans-");
}

export function campGroupFromLibrary(payload: unknown): CampGroupEntry | null {
  const entries = record(payload)?.entries;
  if (!Array.isArray(entries)) throw new Error("Invalid camp group library");
  // Match the mini-program: always use the declared Simplified Chinese entry.
  const entry = entries.map(record).find((item) => item?.id === "life_after" &&
    (Array.isArray(item.languages) ? item.languages : [item.languages]).some(isSimplifiedChinese));
  if (!entry) return null;
  if (!Array.isArray(entry.blocks)) throw new Error("Invalid camp group blocks");
  const blocks: CampGroupBlock[] = [];
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

export async function loadCampGroup(): Promise<CampGroupEntry | null> {
  const upstream = await fetch(LIBRARY_URL, {
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    cf: { cacheEverything: true, cacheTtl: 300 }
  });
  if (!upstream.ok || !upstream.body) {
    await upstream.body?.cancel();
    throw new Error("Camp group library unavailable");
  }
  const reader = upstream.body.getReader();
  const chunks: Uint8Array[] = [];
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
  return campGroupFromLibrary(JSON.parse(new TextDecoder().decode(bytes)));
}
