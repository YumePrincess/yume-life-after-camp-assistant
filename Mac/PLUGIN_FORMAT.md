# Yume Life After Agent plugin format

Agent plugins are distributed as a single `.ylaplugin` ZIP archive. The archive
contains one directory with `plugin.json`, the declared `.mjs` entry point, and
any private resources used by that plugin.

Only `arm64` is accepted. Remote packages must declare SHA-256 hashes for every
payload file and carry an Ed25519 signature from a key configured in
`plugins.trustedKeys`. The signature covers the canonical, key-sorted manifest
without its `signature` field. Catalog downloads are verified a second time
against the package SHA-256 from `/agent-plugins/index.json`.

Local packages use the same checks. An unsigned package can only be installed
when the user explicitly enables developer mode (`allowUnsignedLocal`) or
confirms the one-time `--allow-unsigned` command. Unsigned packages are never
accepted from the Workers catalog.

Package a plugin:

```sh
npm run plugin:package -- ./my-plugin ./my-plugin.ylaplugin
```

For a signed release, set `YLA_PLUGIN_SIGNING_KEY` to an Ed25519 private-key
PEM file and `YLA_PLUGIN_SIGNING_KEY_ID` to the matching trusted key id.

To publish through Workers + Assets, copy signed `.ylaplugin` files into
`Server/public/agent-plugins/packages/`, then run:

```sh
npm run plugin:catalog:build
```

The generated `index.json` is deployed with the existing Worker Assets bundle.
The app checks this catalog for arm64-compatible updates and verifies both the
catalog SHA-256 and the package's Ed25519 signature before atomic installation.
If activation fails, the prior plugin directory is restored automatically.
