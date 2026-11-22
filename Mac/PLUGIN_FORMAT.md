# Yume Life After Agent plugin folders

Agent plugins are plain, unencrypted folders. Each folder contains a
`plugin.json`, the declared `.mjs` entry point, and any resources declared by
the manifest. Only Apple Silicon (`arm64`) plugins are accepted.

The seven official plugins live in `Mac/plugins/` and are copied into the signed
App Runtime during a build. They can be enabled or disabled, but a local folder
cannot replace or remove an official plugin id. To update an official plugin,
replace its source folder and rebuild the App.

Extra plugins live in:

```text
~/Library/Application Support/Yume Life After Mac Agent/Plugins/<plugin-id>/
```

The App's plugin page can open this directory. Copy the complete folder there,
then restart the Agent and refresh the plugin page. A signed local plugin must
include SHA-256 hashes for every payload file and an Ed25519 signature whose key
is configured in `plugins.trustedKeys`. Unsigned local folders load only when
developer mode (`allowUnsignedLocal`) is explicitly enabled.

App plugins are never fetched from Workers. Workers has its own independent,
build-time plugin folders under `Workers/plugins/`.

## Plugin-owned runtime configuration

An Agent entry module may export an optional `config` object alongside the
manifest's workflow export:

```js
import { config } from "./config.mjs";
export { run } from "../../src/workflows/example.mjs";
export { config };
```

The Agent injects that object only into the task that owns the plugin. Its
`flows`, `tables`, hitboxes, OCR regions, waits, and other feature-specific
calibration values override the generic Runtime config for that task. This is
the supported location for non-generic points and screen recognition rules;
they must not be added back to the global `config.json` or
`config.example.json`. The signed App Runtime includes these plugin modules,
and the plugin loader rejects a non-object `config` export.
