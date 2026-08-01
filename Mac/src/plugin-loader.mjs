import { createHash, verify as verifySignature } from "node:crypto";
import { access, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const PLUGIN_SCHEMA_VERSION = 1;
export const APP_PLUGIN_EXTENSION = ".ylaplugin";

export async function loadTaskPlugins({
  builtinDirectory,
  userDirectory,
  disabledPluginIds = [],
  uninstalledPluginIds = [],
  trustedKeys = {},
  allowUnsignedLocal = false
}) {
  const disabled = new Set(disabledPluginIds);
  const uninstalled = new Set(uninstalledPluginIds);
  const sources = [
    { directory: builtinDirectory, builtin: true },
    { directory: userDirectory, builtin: false }
  ];
  const pluginById = new Map();
  const errors = [];
  for (const source of sources) {
    if (!source.directory) continue;
    for (const directory of await pluginDirectories(source.directory)) {
      try {
        const plugin = await loadPlugin(directory, {
          ...source,
          trustedKeys,
          allowUnsignedLocal
        });
        // User plugins are loaded after built-ins and intentionally replace the
        // same plugin id. This is what lets a signed catalog release update a
        // built-in workflow without modifying the read-only app bundle.
        if (!disabled.has(plugin.manifest.id) && !uninstalled.has(plugin.manifest.id)) {
          pluginById.set(plugin.manifest.id, plugin);
        }
      } catch (error) {
        errors.push({ directory, message: error.message });
      }
    }
  }

  const plugins = [...pluginById.values()];
  const workflows = {};
  for (const plugin of plugins) {
    const taskKey = plugin.manifest.task.key;
    if (workflows[taskKey]) {
      throw new Error(
        `Plugin task collision for ${taskKey}: ${workflows[taskKey].manifest.id} and ${plugin.manifest.id}`
      );
    }
    workflows[taskKey] = plugin;
  }
  return { workflows, plugins, errors };
}

export async function inspectPluginDirectory(
  directory,
  { builtin = false, trustedKeys = {}, allowUnsignedLocal = false } = {}
) {
  return loadPlugin(directory, {
    builtin,
    trustedKeys,
    allowUnsignedLocal,
    inspectOnly: true
  });
}

async function loadPlugin(
  directory,
  { builtin, trustedKeys, allowUnsignedLocal, inspectOnly = false }
) {
  const manifest = JSON.parse(
    await readFile(resolve(directory, "plugin.json"), "utf8")
  );
  validateManifest(manifest, { builtin });
  if (!architectureMatches(manifest.architectures)) {
    throw new Error(
      `${manifest.id} does not support ${process.arch}; supported: ${manifest.architectures.join(", ")}`
    );
  }
  await verifyFiles(directory, manifest.files || {}, { requireComplete: !builtin });
  const signature = verifyManifestSignature(manifest, trustedKeys);
  if (!builtin && !signature.verified && !allowUnsignedLocal) {
    throw new Error(
      `${manifest.id} is not signed by a trusted plugin publisher (${signature.reason})`
    );
  }
  const entryPath = await resolveContainedEntry(directory, manifest.entry, builtin);
  if (inspectOnly) {
    return { manifest, directory, entryPath, builtin, signature };
  }
  const module = await import(pathToFileURL(entryPath).href);
  const workflow = module[manifest.export];
  if (typeof workflow !== "function") {
    throw new Error(`${manifest.id} export ${manifest.export} is not a function`);
  }
  return { manifest, directory, entryPath, builtin, signature, workflow };
}

async function pluginDirectories(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(root, entry.name))
    .sort();
}

function validateManifest(manifest, { builtin }) {
  if (manifest.schemaVersion !== PLUGIN_SCHEMA_VERSION) {
    throw new Error(`Unsupported plugin schema ${manifest.schemaVersion}`);
  }
  if (!/^[a-z0-9][a-z0-9.-]{2,79}$/.test(manifest.id || "")) {
    throw new Error("Plugin id is invalid");
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version || "")) {
    throw new Error(`${manifest.id} version must use semantic versioning`);
  }
  if (manifest.kind !== "task") throw new Error(`${manifest.id} kind must be task`);
  if (!Array.isArray(manifest.architectures) || !manifest.architectures.length) {
    throw new Error(`${manifest.id} must declare architectures`);
  }
  if (!manifest.architectures.every((value) => value === "arm64")) {
    throw new Error(`${manifest.id} may only target arm64 Apple Silicon`);
  }
  if (!/^[a-z][a-z0-9_]{2,79}$/.test(manifest.task?.key || "")) {
    throw new Error(`${manifest.id} task key is invalid`);
  }
  if (typeof manifest.entry !== "string" || !manifest.entry.endsWith(".mjs")) {
    throw new Error(`${manifest.id} entry must be an .mjs file`);
  }
  if (!builtin && (isAbsolute(manifest.entry) || manifest.entry.includes(".."))) {
    throw new Error(`${manifest.id} external entry must remain inside its package`);
  }
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(manifest.export || "")) {
    throw new Error(`${manifest.id} export name is invalid`);
  }
}

function architectureMatches(architectures) {
  return process.arch === "arm64" && architectures.includes("arm64");
}

async function resolveContainedEntry(directory, entry, builtin) {
  const entryPath = resolve(directory, entry);
  await access(entryPath);
  if (!builtin) {
    const [base, target] = await Promise.all([realpath(directory), realpath(entryPath)]);
    const within = relative(base, target);
    if (!within || within === ".") throw new Error("Plugin entry cannot be a directory");
    if (within.startsWith(`..${sep}`) || isAbsolute(within)) {
      throw new Error("Plugin entry escaped its package directory");
    }
  }
  return entryPath;
}

async function verifyFiles(directory, files, { requireComplete = false } = {}) {
  if (requireComplete) {
    const actualFiles = await listPayloadFiles(directory);
    const declared = Object.keys(files).sort();
    if (JSON.stringify(actualFiles) !== JSON.stringify(declared)) {
      throw new Error("Plugin manifest must hash every payload file");
    }
  }
  for (const [path, expected] of Object.entries(files)) {
    if (isAbsolute(path) || path.includes("..")) {
      throw new Error(`Plugin file path is unsafe: ${path}`);
    }
    const data = await readFile(resolve(directory, path));
    const actual = createHash("sha256").update(data).digest("hex");
    if (actual !== expected) throw new Error(`Plugin file hash mismatch: ${path}`);
  }
}

async function listPayloadFiles(root, prefix = "") {
  const result = [];
  for (const entry of await readdir(resolve(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Plugin symlinks are not allowed: ${path}`);
    if (entry.isDirectory()) result.push(...(await listPayloadFiles(root, path)));
    else if (entry.isFile() && path !== "plugin.json") result.push(path);
    else if (!entry.isFile()) throw new Error(`Unsupported plugin file type: ${path}`);
  }
  return result.sort();
}

function verifyManifestSignature(manifest, trustedKeys) {
  if (!manifest.signature?.keyId || !manifest.signature?.value) {
    return { verified: false, reason: "missing signature" };
  }
  const publicKey = trustedKeys[manifest.signature.keyId];
  if (!publicKey) return { verified: false, reason: "unknown signing key" };
  const verified = verifySignature(
    null,
    Buffer.from(canonicalPluginPayload(manifest)),
    publicKey,
    Buffer.from(manifest.signature.value, "base64")
  );
  return { verified, reason: verified ? null : "invalid signature" };
}

export function canonicalPluginPayload(manifest) {
  const clone = structuredClone(manifest);
  delete clone.signature;
  return stableJson(clone);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
