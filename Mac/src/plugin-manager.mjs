import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig, MAC_ROOT } from "./config.mjs";
import { inspectPluginDirectory } from "./plugin-loader.mjs";

// Official plugins are bundled as plain folders under Runtime/plugins. They are
// updated only by replacing those source folders and rebuilding the signed App.
// Additional local folder plugins may live in Application Support, but this
// manager intentionally exposes no catalog or network-update command.
const config = await loadConfig({
  resolveSecrets: false,
  validateCredentials: false
});
const command = process.argv[2] || "list";

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
      return { plugins: await listBundledPlugins() };
    case "enable":
      return setPluginEnabled(required(args[0], "plugin id"), true);
    case "disable":
      return setPluginEnabled(required(args[0], "plugin id"), false);
    case "remove":
      return removeLocalPlugin(required(args[0], "plugin id"));
    default:
      throw new Error("Usage: plugin-manager.mjs {list|enable <id>|disable <id>|remove <id>}");
  }
}

async function listBundledPlugins() {
  const disabled = new Set(config.plugins.disabled || []);
  const effective = new Map();
  // Local plugins load first; a bundled plugin with the same id always wins.
  for (const [root, builtin] of [
    [config.plugins.userDirectory, false],
    [resolve(MAC_ROOT, "plugins"), true]
  ]) {
    await mkdir(root, { recursive: true });
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries.filter((item) => item.isDirectory())) {
      const directory = resolve(root, entry.name);
      try {
        const inspected = await inspectPluginDirectory(directory, {
          builtin,
          trustedKeys: config.plugins.trustedKeys,
          allowUnsignedLocal: config.plugins.allowUnsignedLocal
        });
        effective.set(inspected.manifest.id, {
          ...publicManifest(inspected.manifest),
          builtin,
          enabled: !disabled.has(inspected.manifest.id),
          signatureVerified: inspected.signature.verified
        });
      } catch (error) {
        effective.set(`${builtin ? "builtin" : "local"}:${entry.name}`, {
          id: entry.name,
          builtin,
          invalid: true,
          error: error.message
        });
      }
    }
  }
  return [...effective.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

async function setPluginEnabled(id, enabled) {
  if (!/^[a-z0-9][a-z0-9.-]{2,79}$/.test(id)) {
    throw new Error("Invalid plugin id");
  }
  const directory = await findPluginDirectoryById(id);
  if (!directory) throw new Error(`Plugin ${id} was not found`);

  const raw = JSON.parse(await readFile(config.__path, "utf8"));
  const plugins = raw.plugins || {};
  const disabled = new Set(plugins.disabled || []);
  if (enabled) disabled.delete(id);
  else disabled.add(id);
  plugins.disabled = [...disabled].sort();
  delete plugins.catalogUrl;
  delete plugins.uninstalled;
  raw.plugins = plugins;
  await writeFile(config.__path, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  return { id, enabled, restartRequired: true };
}

async function removeLocalPlugin(id) {
  if (!/^[a-z0-9][a-z0-9.-]{2,79}$/.test(id)) {
    throw new Error("Invalid plugin id");
  }
  if (await findPluginDirectoryById(id, { bundledOnly: true })) {
    throw new Error("Bundled plugins cannot be removed; disable the plugin instead");
  }
  const target = await findPluginDirectoryById(id, { localOnly: true });
  if (!target) throw new Error(`Local plugin ${id} was not found`);
  await rm(target, { recursive: true, force: true });
  return { removed: id, restartRequired: true };
}

async function findPluginDirectoryById(id, { bundledOnly = false, localOnly = false } = {}) {
  const sources = bundledOnly
    ? [[resolve(MAC_ROOT, "plugins"), true]]
    : localOnly
      ? [[config.plugins.userDirectory, false]]
      : [
        [resolve(MAC_ROOT, "plugins"), true],
        [config.plugins.userDirectory, false]
      ];
  for (const [root, builtin] of sources) {
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
          allowUnsignedLocal: config.plugins.allowUnsignedLocal
        });
        if (inspected.manifest.id === id) return directory;
      } catch {}
    }
  }
  return null;
}

function publicManifest(manifest) {
  return {
    id: manifest.id,
    version: manifest.version,
    build: manifest.build,
    kind: manifest.kind,
    architectures: manifest.architectures,
    task: manifest.task,
    name: manifest.name,
    summary: manifest.summary
  };
}

function required(value, label) {
  if (!value) throw new Error(`Missing ${label}`);
  return value;
}
