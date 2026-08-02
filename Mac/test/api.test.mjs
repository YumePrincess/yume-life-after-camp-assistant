import assert from "node:assert/strict";
import test from "node:test";
import { AgentApi } from "../src/api.mjs";

test("heartbeat retries a transient HTTPS reset", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts < 3) {
      throw new TypeError("fetch failed", {
        cause: { code: "ECONNRESET", hostname: "lifeafter.yume.zone", port: 443 }
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const api = new AgentApi({
      server: {
        baseUrl: "https://lifeafter.yume.zone",
        agentToken: "test",
        agentId: "mac-test",
        agentName: "Test Mac"
      }
    });
    assert.deepEqual(await api.heartbeat({ status: "idle" }), { ok: true });
    assert.equal(attempts, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("run updates retry transient HTTPS resets instead of interrupting a task", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts < 4) {
      throw new TypeError("fetch failed", {
        cause: { code: "ECONNRESET", hostname: "lifeafter.yume.zone", port: 443 }
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const api = new AgentApi({
      server: {
        baseUrl: "https://lifeafter.yume.zone",
        agentToken: "test",
        agentId: "mac-test",
        agentName: "Test Mac"
      }
    });
    assert.deepEqual(
      await api.updateRun("run-test", { currentStep: "openCampPanel" }),
      { ok: true }
    );
    assert.equal(attempts, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("persistent port 443 resets are described as HTTPS transport failures", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed", {
      cause: { code: "ECONNRESET", hostname: "lifeafter.yume.zone", port: 443 }
    });
  };
  try {
    const api = new AgentApi({
      server: {
        baseUrl: "https://lifeafter.yume.zone",
        agentToken: "test",
        agentId: "mac-test",
        agentName: "Test Mac"
      }
    });
    await assert.rejects(
      api.heartbeat({ status: "idle" }),
      /这不是 HTTP 443 状态码/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
