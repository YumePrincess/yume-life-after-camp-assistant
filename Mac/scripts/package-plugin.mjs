import { createHash, sign } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { canonicalPluginPayload } from "../src/plugin-loader.mjs";
import { runFile } from "../src/process.mjs";

const source = resolve(process.argv[2] || "");
const output = resolve(process.argv[3] || `${basename(source)}.ylaplugin`);
const manifest = JSON.parse(await readFile(resolve(source, "plugin.json"), "utf8"));
const stagingRoot = await mkdtemp(resolve(tmpdir(), "yla-package-"));
const staging = resolve(stagingRoot, manifest.id);

try {
  await cp(source, staging, { recursive: true });
  manifest.files = {};
  for (const path of await filesRecursively(staging)) {
    if (path === "plugin.json") continue;
    const data = await readFile(resolve(staging, path));
    manifest.files[path] = createHash("sha256").update(data).digest("hex");
  }
  const privateKeyPath = process.env.YLA_PLUGIN_SIGNING_KEY;
  const keyId = process.env.YLA_PLUGIN_SIGNING_KEY_ID;
  if (privateKeyPath && keyId) {
    const privateKey = await readFile(resolve(privateKeyPath), "utf8");
    manifest.signature = {
      keyId,
      value: sign(null, Buffer.from(canonicalPluginPayload(manifest)), privateKey).toString("base64")
    };
  } else {
    delete manifest.signature;
  }
  await writeFile(resolve(staging, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await rm(output, { force: true });
  await runFile("/usr/bin/ditto", ["-c", "-k", "--keepParent", staging, output], {
    timeoutMs: 30_000
  });
  process.stdout.write(`${output}\n`);
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}

async function filesRecursively(root, prefix = "") {
  const result = [];
  for (const entry of await readdir(resolve(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...(await filesRecursively(root, path)));
    else if (entry.isFile()) result.push(path);
  }
  return result.sort();
}
