import type { WorkerPluginRuntime } from "../../src/plugin-system";

// Technology-specific catalog and localization live with this plugin. The
// Worker core imports these exports for persistence and API presentation, but
// the definitions are no longer part of the generic Server config surface.
export { BUILT_IN_TECHNOLOGY_CATALOG } from "./catalog";
export {
  TECHNOLOGY_LOCALIZATIONS,
  localizeTechnology
} from "./localizations";

export default {} satisfies WorkerPluginRuntime;
