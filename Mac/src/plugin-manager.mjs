import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, resolve } from "node:path";
import { loadConfig, MAC_ROOT } from "./config.mjs";
import {
  APP_PLUGIN_EXTENSION,
  inspectPluginDirectory
} from "./plugin-loader.mjs";
import { runFile } from "./process.mjs";

// Local plugin administration must remain available before the Agent token is
// entered on a new Mac. Network catalog commands still use the configured
// HTTPS URL and signature trust store, but never need the Agent secret.
const config = await loadConfig({
  resolveSecrets: false,
  validateCredentials: false
});
const command = process.argv[2] || "list";
const MAX_PLUGIN_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_PLUGIN_ARCHIVE_ENTRIES = 512;

try {
  const result = await dispatch(command, process.argv.slice(3));
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
  process.exitCode = 1;
}

async function dispatch(action, args) {
  if (process.arch !== "arm64") {
    throw new Error("Yume Life After plugins require an Apple Silicon Mac (arm64)");
  }
  switch (action) {
    case "list":
      return { plugins: await listInstalled() };
    case "install":
      return installPackage(required(args[0], "plugin package"), {
        allowUnsigned: args.includes("--allow-unsigned")
      });
    case "remove":
      return removePlugin(required(args[0], "plugin id"));
    case "enable":
      return setPluginEnabled(required(args[0], "plugin id"), true);
    case "disable":
      return setPluginEnabled(required(args[0], "plugin id"), false);
    case "restore-builtin":
      return restoreBuiltin(required(args[0], "plugin id"));
    case "restore-all-builtins":
      return restoreAllBuiltins();
    case "catalog":
      return { catalog: await fetchCatalog() };
    case "updates":
      return { updates: await availableUpdates() };
    case "install-remote":
      return installRemote(required(args[0], "plugin id"));
    default:
      throw new Error(
        "Usage: plugin-manager.mjs {list|install <file.ylaplugin>|remove <id>|enable <id>|disable <id>|restore-builtin <id>|restore-all-builtins|catalog|updates|install-remote <id>}"
      );
  }
}

async function listInstalled() {
  const effective = new Map();
  const uninstalled = new Set(config.plugins.uninstalled || []);
  for (const [root, builtin] of [
    [resolve(MAC_ROOT, "plugins"), true],
    [config.plugins.userDirectory, false]
  ]) {
    let entries = [];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const entry of entries.filter((item) => item.isDirectory())) {
      const directory = resolve(root, entry.name);
      try {
        const inspected = await inspectPluginDirectory(directory, {
          builtin,
          trustedKeys: config.plugins.trustedKeys,
          allowUnsignedLocal: true
        });
        if (builtin && uninstalled.has(inspected.manifest.id)) continue;
        effective.set(inspected.manifest.id, {
          ...publicManifest(inspected.manifest),
          builtin,
          enabled: !config.plugins.disabled.includes(inspected.manifest.id),
          signatureVerified: inspected.signature.verified,
          signatureReason: inspected.signature.reason
        });
      } catch (error) {
        if (builtin && error.code === "ENOENT") continue;
        effective.set(entry.name, { id: entry.name, builtin, invalid: true, error: error.message });
      }
    }
  }
  return [...effective.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

async function installPackage(path, { allowUnsigned = false } = {}) {
  const packagePath = resolve(path);
  if (![APP_PLUGIN_EXTENSION, ".zip"].includes(extname(packagePath).toLowerCase())) {
    throw new Error(`Plugin packages must use ${APP_PLUGIN_EXTENSION} or .zip`);
  }
  const packageStat = await stat(packagePath);
  if (packageStat.size > MAX_PLUGIN_ARCHIVE_BYTES) {
    throw new Error("Plugin package exceeds the 64 MB safety limit");
  }
  const temporary = await mkdtemp(resolve(tmpdir(), "yla-plugin-"));
  try {
    await validateArchiveEntries(packagePath);
    await runFile("/usr/bin/ditto", ["-x", "-k", packagePath, temporary], {
      timeoutMs: 30_000
    });
    const source = await locatePluginRoot(temporary);
    const inspected = await inspectPluginDirectory(source, {
      trustedKeys: config.plugins.trustedKeys,
      allowUnsignedLocal: config.plugins.allowUnsignedLocal || allowUnsigned
    });
    const target = resolve(config.plugins.userDirectory, inspected.manifest.id);
    const staging = `${target}.installing`;
    const backup = `${target}.previous`;
    await mkdir(config.plugins.userDirectory, { recursive: true });
    await rm(staging, { recursive: true, force: true });
    await cp(source, staging, { recursive: true, errorOnExist: true });
    await rm(backup, { recursive: true, force: true });
    await clearPluginTombstone(inspected.manifest.id);
    try {
      await rename(target, backup);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await rename(staging, target);
    } catch (error) {
      try {
        await rename(backup, target);
      } catch {}
      throw error;
    }
    await rm(backup, { recursive: true, force: true });
    return {
      installed: publicManifest(inspected.manifest),
      signatureVerified: inspected.signature.verified,
      restartRequired: true
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function removePlugin(id) {
  if (!/^[a-z0-9][a-z0-9.-]{2,79}$/.test(id)) throw new Error("Invalid plugin id");
  const builtin = resolve(MAC_ROOT, "plugins", id);
  let hasBuiltin = false;
  try {
    await stat(builtin);
    hasBuiltin = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const target = resolve(config.plugins.userDirectory, id);
  await rm(target, { recursive: true, force: true });
  if (hasBuiltin) await setPluginTombstone(id, true);
  return { removed: id, restartRequired: true };
}

async function setPluginEnabled(id, enabled) {
  if (!/^[a-z0-9][a-z0-9.-]{2,79}$/.test(id)) throw new Error("Invalid plugin id");
  const raw = JSON.parse(await readFile(config.__path, "utf8"));
  raw.plugins ||= {};
  const disabled = new Set(raw.plugins.disabled || []);
  if (enabled) disabled.delete(id);
  else disabled.add(id);
  raw.plugins.disabled = [...disabled].sort();
  await writeFile(config.__path, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  return { id, enabled, restartRequired: true };
}

async function restoreBuiltin(id) {
  await stat(resolve(MAC_ROOT, "plugins", id));
  await setPluginTombstone(id, false);
  return { restored: id, restartRequired: true };
}

async function restoreAllBuiltins() {
  const raw = JSON.parse(await readFile(config.__path, "utf8"));
  raw.plugins ||= {};
  raw.plugins.uninstalled = [];
  await writeFile(config.__path, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  return { restoredAllBuiltins: true, restartRequired: true };
}

async function clearPluginTombstone(id) {
  await setPluginTombstone(id, false);
}

async function setPluginTombstone(id, removed) {
  const raw = JSON.parse(await readFile(config.__path, "utf8"));
  raw.plugins ||= {};
  const uninstalled = new Set(raw.plugins.uninstalled || []);
  const disabled = new Set(raw.plugins.disabled || []);
  if (removed) {
    uninstalled.add(id);
    disabled.delete(id);
  } else {
    uninstalled.delete(id);
  }
  raw.plugins.uninstalled = [...uninstalled].sort();
  raw.plugins.disabled = [...disabled].sort();
  await writeFile(config.__path, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
}

async function fetchCatalog() {
  const url = config.plugins.catalogUrl;
  if (!/^https:\/\//.test(url || "")) throw new Error("Plugin catalog must use HTTPS");
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Plugin catalog returned HTTP ${response.status}`);
  const catalog = await response.json();
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.plugins)) {
    throw new Error("Plugin catalog schema is invalid");
  }
  return catalog;
}

async function availableUpdates() {
  const [catalog, installed] = await Promise.all([fetchCatalog(), listInstalled()]);
  const versions = new Map(installed.map((plugin) => [plugin.id, plugin.version]));
  return catalog.plugins.filter(
    (plugin) =>
      plugin.architectures?.includes("arm64") &&
      (!versions.has(plugin.id) || compareVersions(plugin.version, versions.get(plugin.id)) > 0)
  );
}

async function installRemote(id) {
  const catalog = await fetchCatalog();
  const plugin = catalog.plugins.find((item) => item.id === id);
  if (!plugin) throw new Error(`Plugin ${id} was not found in the catalog`);
  if (!plugin.architectures?.includes("arm64")) {
    throw new Error(`Plugin ${id} does not support Apple Silicon`);
  }
  const url = new URL(plugin.url, config.plugins.catalogUrl);
  if (url.protocol !== "https:") throw new Error("Remote plugin URL must use HTTPS");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Plugin download returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_PLUGIN_ARCHIVE_BYTES) {
    throw new Error("Downloaded plugin exceeds the 64 MB safety limit");
  }
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== plugin.sha256) throw new Error("Downloaded plugin hash does not match catalog");
  const temporary = resolve(tmpdir(), `${id}-${plugin.version}${APP_PLUGIN_EXTENSION}`);
  await writeFile(temporary, bytes, { mode: 0o600 });
  try {
    return await installPackage(temporary);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function validateArchiveEntries(path) {
  const result = await runFile("/usr/bin/unzip", ["-Z1", path], { timeoutMs: 10_000 });
  const entries = result.stdout.split(/\r?\n/).filter(Boolean);
  if (entries.length > MAX_PLUGIN_ARCHIVE_ENTRIES) {
    throw new Error("Plugin archive contains too many files");
  }
  for (const entry of entries) {
    if (entry.startsWith("/") || entry.split("/").includes("..")) {
      throw new Error(`Plugin archive contains an unsafe path: ${entry}`);
    }
  }
}

async function locatePluginRoot(root) {
  try {
    await readFile(resolve(root, "plugin.json"));
    return root;
  } catch {}
  const entries = (await readdir(root, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && entry.name !== "__MACOSX"
  );
  if (entries.length !== 1) throw new Error("Plugin archive must contain one plugin root");
  const candidate = resolve(root, entries[0].name);
  await readFile(resolve(candidate, "plugin.json"));
  return candidate;
}

function publicManifest(manifest) {
  return {
    id: manifest.id,
    version: manifest.version,
    kind: manifest.kind,
    architectures: manifest.architectures,
    task: manifest.task,
    name: manifest.name,
    summary: manifest.summary
  };
}

function compareVersions(left, right) {
  const a = String(left).split(/[.+-]/).slice(0, 3).map(Number);
  const b = String(right).split(/[.+-]/).slice(0, 3).map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
  }
  return 0;
}

function required(value, label) {
  if (!value) throw new Error(`Missing ${label}`);
  return value;
}
