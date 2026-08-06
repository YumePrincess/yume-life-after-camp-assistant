import {
  cancelQueuedRunsForTaskKeys,
  getWorkerPluginStateMap,
  saveWorkerPluginStateMap
} from "./db";
import { WORKER_PLUGINS } from "./generated/plugin-registry";

export interface WorkerPluginPermission {
  key: string;
  label: string;
  aliases?: string[];
}

export interface WorkerPluginTask {
  key: string;
  name: string;
  description: string;
  runPermission: string;
}

export interface WorkerPluginAdminModule {
  view: string;
  label: string;
  permission: string;
}

export interface WorkerPluginManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  build: number;
  displayName: string;
  description: string;
  builtin: boolean;
  defaultEnabled: boolean;
  tasks: WorkerPluginTask[];
  permissions: WorkerPluginPermission[];
  adminModules: WorkerPluginAdminModule[];
  clientModule?: string;
}

export interface WorkerPluginRequestContext {
  request: Request;
  env: Env;
  path: string;
  method: string;
  scope: "public" | "agent" | "admin";
}

export interface WorkerPluginRuntime {
  handleRequest?(context: WorkerPluginRequestContext): Promise<Response | null>;
}

export interface RegisteredWorkerPlugin {
  manifest: WorkerPluginManifest;
  runtime: WorkerPluginRuntime;
}

export interface EffectiveWorkerPlugin extends WorkerPluginManifest {
  enabled: boolean;
}

export interface PermissionCatalogEntry {
  key: string;
  label: string;
  pluginId: string | null;
  aliases: string[];
}

export const CORE_PERMISSION_CATALOG: readonly PermissionCatalogEntry[] = [
  { key: "system:admin", label: "系统最高权限", pluginId: null, aliases: [] },
  { key: "demo:preview", label: "Demo · 全后台只读", pluginId: null, aliases: [] },
  { key: "admin:overview", label: "控制台", pluginId: null, aliases: ["task:run"] },
  { key: "admin:general", label: "基础设置", pluginId: null, aliases: ["config:write"] },
  { key: "admin:tasks", label: "任务计划", pluginId: null, aliases: ["config:write"] },
  { key: "admin:agent", label: "执行策略", pluginId: null, aliases: ["config:write"] },
  { key: "admin:plugins", label: "Workers 插件", pluginId: null, aliases: ["plugins:manage"] },
  { key: "admin:identity-review", label: "识别码审批", pluginId: null, aliases: ["identity:review"] },
  { key: "admin:identity-codes", label: "身份识别码", pluginId: null, aliases: ["identity:manage"] },
  { key: "admin:smtp", label: "SMTP 发信", pluginId: null, aliases: ["smtp:manage"] },
  { key: "admin:access", label: "访问密钥", pluginId: null, aliases: ["keys:manage"] },
  { key: "admin:history", label: "运行记录", pluginId: null, aliases: ["task:interrupt"] },
  { key: "config:write", label: "修改核心配置", pluginId: null, aliases: ["admin:general", "admin:tasks", "admin:agent"] },
  { key: "task:run", label: "执行全部已启用插件任务（兼容）", pluginId: null, aliases: ["admin:overview"] },
  { key: "task:interrupt", label: "中断任务", pluginId: null, aliases: ["admin:history"] },
  { key: "keys:manage", label: "管理 Key", pluginId: null, aliases: ["admin:access"] },
  { key: "plugins:manage", label: "启停 Workers 插件", pluginId: null, aliases: ["admin:plugins"] },
  { key: "identity:review", label: "审批身份识别码", pluginId: null, aliases: ["admin:identity-review"] },
  { key: "identity:manage", label: "管理身份识别码", pluginId: null, aliases: ["admin:identity-codes"] },
  { key: "smtp:manage", label: "管理 SMTP 配置", pluginId: null, aliases: ["admin:smtp"] }
];

export function registeredWorkerPlugins(): readonly RegisteredWorkerPlugin[] {
  return WORKER_PLUGINS;
}

export async function effectiveWorkerPlugins(env: Env): Promise<EffectiveWorkerPlugin[]> {
  const states = await getWorkerPluginStateMap(env);
  return WORKER_PLUGINS.map(({ manifest }) => ({
    ...manifest,
    enabled: states[manifest.id] ?? manifest.defaultEnabled
  }));
}

export async function isWorkerPluginEnabled(env: Env, pluginId: string): Promise<boolean> {
  const plugin = WORKER_PLUGINS.find((item) => item.manifest.id === pluginId);
  if (!plugin) return false;
  const states = await getWorkerPluginStateMap(env);
  return states[pluginId] ?? plugin.manifest.defaultEnabled;
}

export async function setWorkerPluginEnabled(env: Env, pluginId: string, enabled: boolean): Promise<boolean> {
  const plugin = WORKER_PLUGINS.find((item) => item.manifest.id === pluginId);
  if (!plugin) return false;
  const states = await getWorkerPluginStateMap(env);
  states[pluginId] = enabled;
  await saveWorkerPluginStateMap(env, states);
  if (!enabled) {
    await cancelQueuedRunsForTaskKeys(
      env,
      plugin.manifest.tasks.map((task) => task.key)
    );
  }
  return true;
}

export async function enabledPermissionCatalog(env: Env): Promise<PermissionCatalogEntry[]> {
  const plugins = await effectiveWorkerPlugins(env);
  return [
    ...CORE_PERMISSION_CATALOG,
    ...plugins.flatMap((plugin) => plugin.enabled
      ? plugin.permissions.map((permission) => ({
          key: permission.key,
          label: permission.label,
          pluginId: plugin.id,
          aliases: permission.aliases ?? []
        }))
      : [])
  ];
}

export function builtPermissionCatalog(): PermissionCatalogEntry[] {
  return [
    ...CORE_PERMISSION_CATALOG,
    ...WORKER_PLUGINS.flatMap(({ manifest }) => manifest.permissions.map((permission) => ({
      key: permission.key,
      label: permission.label,
      pluginId: manifest.id,
      aliases: permission.aliases ?? []
    })))
  ];
}

export async function enabledPluginForTask(env: Env, taskKey: string): Promise<EffectiveWorkerPlugin | null> {
  const plugins = await effectiveWorkerPlugins(env);
  return plugins.find((plugin) => plugin.enabled && plugin.tasks.some((task) => task.key === taskKey)) ?? null;
}

export function builtPluginForTask(taskKey: string): WorkerPluginManifest | null {
  return WORKER_PLUGINS.find(({ manifest }) =>
    manifest.tasks.some((task) => task.key === taskKey)
  )?.manifest ?? null;
}

export function builtPluginForPermission(permission: string): WorkerPluginManifest | null {
  return WORKER_PLUGINS.find(({ manifest }) => manifest.permissions.some((item) => item.key === permission))?.manifest ?? null;
}

export async function dispatchWorkerPluginRequest(
  context: WorkerPluginRequestContext
): Promise<Response | null> {
  const match = new RegExp(`^/api/${context.scope}/plugins/([^/]+)(?:/|$)`).exec(
    context.path
  );
  if (!match) return null;
  const pluginId = decodeURIComponent(match[1] ?? "");
  const plugin = WORKER_PLUGINS.find((item) => item.manifest.id === pluginId);
  if (!plugin) return new Response("Plugin not found", { status: 404 });
  if (!(await isWorkerPluginEnabled(context.env, pluginId))) {
    return new Response("Plugin disabled", { status: 409 });
  }
  if (!plugin.runtime.handleRequest) {
    return new Response("Plugin route not found", { status: 404 });
  }
  return (await plugin.runtime.handleRequest(context)) ??
    new Response("Plugin route not found", { status: 404 });
}
