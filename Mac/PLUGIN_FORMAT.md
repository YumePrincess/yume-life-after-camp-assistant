# Yume Life After Agent plugin folders

Agent plugins are plain, unencrypted folders. Each folder contains a
`plugin.json`, the declared `.mjs` entry point, and any resources declared by
the manifest. Only Apple Silicon (`arm64`) plugins are accepted.

The five official plugins live in `Mac/plugins/` and are copied into the signed
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
build-time plugin folders under `Server/plugins/`.
