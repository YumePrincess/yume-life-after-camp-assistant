import { access, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginsRoot = path.join(root, "plugins");
const generatedSource = path.join(root, "src", "generated", "plugin-registry.ts");
const generatedPublic = path.join(root, "public", "generated", "plugins.json");
const generatedClientRoot = path.join(root, "public", "generated", "plugins");
const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const PERMISSION_PATTERN = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9:-]*$/;
const TASK_PATTERN = /^[a-z][a-z0-9_]*$/;

function fail(message) {
  throw new Error(`Worker plugin manifest error: ${message}`);
}

function requiredText(value, field) {
  if (typeof value !== "string" || !value.trim()) fail(`${field} must be a non-empty string`);
  return value.trim();
}

function validateManifest(value, directoryName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${directoryName}/plugin.json must contain an object`);
  if (value.schemaVersion !== 1) fail(`${directoryName}: schemaVersion must be 1`);
  const id = requiredText(value.id, `${directoryName}.id`);
  if (!ID_PATTERN.test(id)) fail(`${directoryName}.id is invalid`);
  if (id !== directoryName) fail(`${directoryName}.id must match its directory name`);
  const version = requiredText(value.version, `${directoryName}.version`);
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) fail(`${directoryName}.version is invalid`);
  const tasks = Array.isArray(value.tasks) ? value.tasks : [];
  const permissions = Array.isArray(value.permissions) ? value.permissions : [];
  const adminModules = Array.isArray(value.adminModules) ? value.adminModules : [];
  for (const [index, task] of tasks.entries()) {
    if (!task || typeof task !== "object" || Array.isArray(task)) fail(`${directoryName}.tasks[${index}] must be an object`);
    if (!TASK_PATTERN.test(requiredText(task.key, `${directoryName}.tasks[${index}].key`))) fail(`${directoryName}.tasks[${index}].key is invalid`);
    requiredText(task.name, `${directoryName}.tasks[${index}].name`);
    requiredText(task.description, `${directoryName}.tasks[${index}].description`);
    requiredText(task.runPermission, `${directoryName}.tasks[${index}].runPermission`);
  }
  for (const [index, permission] of permissions.entries()) {
    if (!permission || typeof permission !== "object" || Array.isArray(permission)) fail(`${directoryName}.permissions[${index}] must be an object`);
    const key = requiredText(permission.key, `${directoryName}.permissions[${index}].key`);
    if (!PERMISSION_PATTERN.test(key)) fail(`${directoryName}.permissions[${index}].key is invalid`);
    requiredText(permission.label, `${directoryName}.permissions[${index}].label`);
    if (permission.aliases !== undefined && (!Array.isArray(permission.aliases) || permission.aliases.some((item) => typeof item !== "string"))) {
      fail(`${directoryName}.permissions[${index}].aliases must be an array of strings`);
    }
  }
  for (const [index, module] of adminModules.entries()) {
    if (!module || typeof module !== "object" || Array.isArray(module)) fail(`${directoryName}.adminModules[${index}] must be an object`);
    requiredText(module.view, `${directoryName}.adminModules[${index}].view`);
    requiredText(module.label, `${directoryName}.adminModules[${index}].label`);
    requiredText(module.permission, `${directoryName}.adminModules[${index}].permission`);
  }
  return {
    schemaVersion: 1,
    id,
    version,
    displayName: requiredText(value.displayName, `${directoryName}.displayName`),
    description: requiredText(value.description, `${directoryName}.description`),
    builtin: value.builtin === true,
    defaultEnabled: value.defaultEnabled !== false,
    tasks,
    permissions,
    adminModules
  };
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

const directories = (await readdir(pluginsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
  .map((entry) => entry.name)
  .sort();
const plugins = [];
for (const directory of directories) {
  const manifestFile = path.join(pluginsRoot, directory, "plugin.json");
  if (!(await exists(manifestFile))) fail(`${directory} is missing plugin.json`);
  const manifest = validateManifest(JSON.parse(await readFile(manifestFile, "utf8")), directory);
  const serverFile = path.join(pluginsRoot, directory, "server.ts");
  if (!(await exists(serverFile))) fail(`${directory} is missing server.ts`);
  const clientFile = path.join(pluginsRoot, directory, "admin.js");
  if (await exists(clientFile)) {
    manifest.clientModule = `/generated/plugins/${directory}.js`;
  }
  plugins.push(manifest);
}

const allTasks = new Map();
const allPermissions = new Map();
const allViews = new Map();
for (const plugin of plugins) {
  for (const task of plugin.tasks) {
    if (allTasks.has(task.key)) fail(`task ${task.key} is declared by both ${allTasks.get(task.key)} and ${plugin.id}`);
    allTasks.set(task.key, plugin.id);
  }
  for (const permission of plugin.permissions) {
    if (allPermissions.has(permission.key)) fail(`permission ${permission.key} is declared by both ${allPermissions.get(permission.key)} and ${plugin.id}`);
    allPermissions.set(permission.key, plugin.id);
  }
  for (const module of plugin.adminModules) {
    if (allViews.has(module.view)) fail(`admin view ${module.view} is declared by both ${allViews.get(module.view)} and ${plugin.id}`);
    allViews.set(module.view, plugin.id);
  }
}

const imports = plugins.map((plugin, index) => `import runtime${index} from "../../plugins/${plugin.id}/server";`).join("\n");
const entries = plugins.map((plugin, index) => `  { manifest: ${JSON.stringify(plugin)}, runtime: runtime${index} as RegisteredWorkerPlugin["runtime"] }`).join(",\n");
const source = `// Generated by scripts/generate-plugin-registry.mjs. Do not edit.\nimport type { RegisteredWorkerPlugin } from "../plugin-system";\n${imports}\n\nexport const WORKER_PLUGINS = [\n${entries}\n] as const satisfies readonly RegisteredWorkerPlugin[];\n`;
const publicRegistry = JSON.stringify({ schemaVersion: 1, plugins }, null, 2) + "\n";
await mkdir(path.dirname(generatedSource), { recursive: true });
await mkdir(path.dirname(generatedPublic), { recursive: true });
await rm(generatedClientRoot, { recursive: true, force: true });
await mkdir(generatedClientRoot, { recursive: true });
for (const plugin of plugins) {
  if (!plugin.clientModule) continue;
  await copyFile(
    path.join(pluginsRoot, plugin.id, "admin.js"),
    path.join(generatedClientRoot, `${plugin.id}.js`)
  );
}
await writeFile(generatedSource, source);
await writeFile(generatedPublic, publicRegistry);
console.log(`Generated Worker plugin registry with ${plugins.length} plugin(s).`);
