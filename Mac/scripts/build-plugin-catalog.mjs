import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { runFile } from "../src/process.mjs";

const projectRoot = resolve(import.meta.dirname, "../..");
const assetsRoot = resolve(projectRoot, "Server/public/agent-plugins");
const packagesRoot = resolve(assetsRoot, "packages");
const baseUrl = process.env.YLA_PLUGIN_ASSET_BASE_URL || "/agent-plugins/packages/";

await mkdir(packagesRoot, { recursive: true });
const entries = (await readdir(packagesRoot, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".ylaplugin"))
  .sort((a, b) => a.name.localeCompare(b.name));

const plugins = [];
for (const entry of entries) {
  const archive = resolve(packagesRoot, entry.name);
  const manifest = await readManifest(archive);
  if (!manifest.signature?.keyId || !manifest.signature?.value) {
    throw new Error(`${entry.name} is unsigned; Workers catalog packages must be signed`);
  }
  const bytes = await readFile(archive);
  plugins.push({
    id: manifest.id,
    version: manifest.version,
    architectures: manifest.architectures,
    minimumAgentVersion: manifest.minimumAgentVersion,
    url: `${baseUrl}${encodeURIComponent(entry.name)}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    name: manifest.name,
    summary: manifest.summary
  });
}

const catalog = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  plugins
};
await writeFile(resolve(assetsRoot, "index.json"), `${JSON.stringify(catalog, null, 2)}\n`);
process.stdout.write(`Wrote ${plugins.length} plugin(s) to ${relative(projectRoot, resolve(assetsRoot, "index.json"))}\n`);

async function readManifest(archive) {
  const listing = await runFile("/usr/bin/unzip", ["-Z1", archive], { timeoutMs: 10_000 });
  const manifestEntry = listing.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .find((path) => path === "plugin.json" || path.endsWith("/plugin.json"));
  if (!manifestEntry) throw new Error(`${basename(archive)} has no plugin.json`);
  if (manifestEntry.startsWith("/") || manifestEntry.split("/").includes("..")) {
    throw new Error(`${basename(archive)} has an unsafe manifest path`);
  }
  const result = await runFile("/usr/bin/unzip", ["-p", archive, manifestEntry], {
    timeoutMs: 10_000
  });
  return JSON.parse(result.stdout);
}
