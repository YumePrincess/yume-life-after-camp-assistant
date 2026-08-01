import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  canonicalPluginPayload,
  inspectPluginDirectory,
  loadTaskPlugins
} from "../src/plugin-loader.mjs";

test("unsigned external plugins are rejected unless developer mode is explicit", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "yla-plugin-test-"));
  try {
    const directory = await createPlugin(root, "zone.yume.test.unsigned");
    await assert.rejects(
      inspectPluginDirectory(directory),
      /not signed by a trusted plugin publisher/
    );
    const inspected = await inspectPluginDirectory(directory, {
      allowUnsignedLocal: true
    });
    assert.equal(inspected.manifest.task.key, "test_task");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a trusted Ed25519 signature verifies the complete plugin payload", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "yla-plugin-test-"));
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const directory = await createPlugin(root, "zone.yume.test.signed", {
      signature: { keyId: "release-1", privateKey }
    });
    const inspected = await inspectPluginDirectory(directory, {
      trustedKeys: {
        "release-1": publicKey.export({ type: "spki", format: "pem" })
      }
    });
    assert.equal(inspected.signature.verified, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a user plugin atomically overrides the same built-in plugin id", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "yla-plugin-test-"));
  try {
    const builtins = resolve(root, "builtins");
    const users = resolve(root, "users");
    await createPlugin(builtins, "zone.yume.test.override", { version: "1.0.0" });
    await createPlugin(users, "zone.yume.test.override", { version: "1.1.0" });
    const loaded = await loadTaskPlugins({
      builtinDirectory: builtins,
      userDirectory: users,
      allowUnsignedLocal: true
    });
    assert.equal(loaded.plugins.length, 1);
    assert.equal(loaded.plugins[0].manifest.version, "1.1.0");
    assert.equal(typeof loaded.workflows.test_task.workflow, "function");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("external plugin manifests must hash every payload file", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "yla-plugin-test-"));
  try {
    const directory = await createPlugin(root, "zone.yume.test.extra");
    await writeFile(resolve(directory, "unlisted.txt"), "not signed");
    await assert.rejects(
      inspectPluginDirectory(directory, { allowUnsignedLocal: true }),
      /must hash every payload file/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createPlugin(
  root,
  id,
  { version = "1.0.0", signature = null } = {}
) {
  const directory = resolve(root, id);
  await mkdir(directory, { recursive: true });
  const entry = "export async function run() { return 'ok'; }\n";
  await writeFile(resolve(directory, "plugin.mjs"), entry);
  const manifest = {
    schemaVersion: 1,
    id,
    version,
    kind: "task",
    architectures: ["arm64"],
    minimumAgentVersion: "0.2.0",
    entry: "plugin.mjs",
    export: "run",
    task: { key: "test_task", positionIndependent: true },
    name: { en: "Test" },
    summary: { en: "Test plugin" },
    files: {
      "plugin.mjs": createHash("sha256").update(entry).digest("hex")
    }
  };
  if (signature) {
    manifest.signature = {
      keyId: signature.keyId,
      value: sign(
        null,
        Buffer.from(canonicalPluginPayload(manifest)),
        signature.privateKey
      ).toString("base64")
    };
  }
  await writeFile(resolve(directory, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return directory;
}
