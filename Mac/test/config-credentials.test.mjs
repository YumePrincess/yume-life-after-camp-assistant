import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

test("runtime credentials use an owner-only file and are cached per process", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "yla-credentials-"));
  const configPath = resolve(root, "config.json");
  const credentialsPath = resolve(root, "credentials.json");
  const previousConfig = process.env.MRZH_CONFIG;
  const previousCredentials = process.env.YLA_CREDENTIALS_FILE;
  try {
    const template = JSON.parse(
      await readFile(new URL("../config.example.json", import.meta.url), "utf8")
    );
    template.server.agentToken = "CREDENTIALS_FILE";
    template.debug.token = "CREDENTIALS_FILE";
    await writeFile(configPath, JSON.stringify(template));
    await writeFile(
      credentialsPath,
      JSON.stringify({ agentToken: "agent-secret", debugToken: "debug-secret" })
    );
    await chmod(credentialsPath, 0o600);
    process.env.MRZH_CONFIG = configPath;
    process.env.YLA_CREDENTIALS_FILE = credentialsPath;

    const { loadConfig } = await import(
      `../src/config.mjs?credentials=${Date.now()}`
    );
    const first = await loadConfig();
    assert.equal(first.server.agentToken, "agent-secret");
    assert.equal(first.debug.token, "debug-secret");

    await writeFile(
      credentialsPath,
      JSON.stringify({ agentToken: "changed-agent", debugToken: "changed-debug" })
    );
    await chmod(credentialsPath, 0o600);
    const second = await loadConfig();
    assert.equal(second.server.agentToken, "agent-secret");
    assert.equal(second.debug.token, "debug-secret");

    const source = await readFile(
      new URL("../src/config.mjs", import.meta.url),
      "utf8"
    );
    assert.doesNotMatch(source, /execFile|\/usr\/bin\/security/);
  } finally {
    if (previousConfig === undefined) delete process.env.MRZH_CONFIG;
    else process.env.MRZH_CONFIG = previousConfig;
    if (previousCredentials === undefined) delete process.env.YLA_CREDENTIALS_FILE;
    else process.env.YLA_CREDENTIALS_FILE = previousCredentials;
    await rm(root, { recursive: true, force: true });
  }
});
