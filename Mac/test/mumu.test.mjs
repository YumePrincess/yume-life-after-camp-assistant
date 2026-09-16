import assert from "node:assert/strict";
import test from "node:test";
import { MumuLifecycle } from "../src/mumu.mjs";

test("MuMu manager recovery kills a wedged manager before its final relaunch", async () => {
  const calls = [];
  let now = 0;
  let portAttempts = 0;
  const config = {
    mumu: {
      appName: "MuMuPlayer",
      appPath: "/Applications/MuMuPlayer.app",
      toolPath: "/Applications/MuMuPlayer.app/Contents/MacOS/mumutool",
      managerProbeTimeoutMs: 5_000,
      managerStartTimeoutSeconds: 10,
      managerRestartAttempts: 1
    }
  };
  const lifecycle = new MumuLifecycle(config, {}, {
    now: () => now,
    delay: async (ms) => {
      now += ms;
    },
    async runFile(file, args) {
      calls.push([file, args]);
      if (file.endsWith("mumutool") && args[0] === "port") {
        portAttempts += 1;
        if (portAttempts < 13) throw new Error("manager port unavailable");
        return { stdout: '{"server-port":21001}' };
      }
      return { stdout: "" };
    }
  });

  await lifecycle.ensureManagerRunning();

  assert.deepEqual(
    calls.filter(([file]) => file === "/usr/bin/open" || file === "/usr/bin/killall"),
    [
      ["/usr/bin/open", ["-gj", "-a", "/Applications/MuMuPlayer.app"]],
      ["/usr/bin/killall", ["-KILL", "MuMuPlayer"]],
      ["/usr/bin/open", ["-gj", "-a", "/Applications/MuMuPlayer.app"]]
    ]
  );
  assert.equal(portAttempts, 13);
});

test("MuMu manager probe succeeds without relaunching a healthy manager", async () => {
  const calls = [];
  const lifecycle = new MumuLifecycle(
    {
      mumu: {
        appName: "MuMuPlayer",
        appPath: "/Applications/MuMuPlayer.app",
        toolPath: "/Applications/MuMuPlayer.app/Contents/MacOS/mumutool"
      }
    },
    {},
    {
      async runFile(file, args) {
        calls.push([file, args]);
        return { stdout: '{"server-port":21001}' };
      }
    }
  );

  await lifecycle.ensureManagerRunning();

  assert.deepEqual(calls, [
    [
      "/Applications/MuMuPlayer.app/Contents/MacOS/mumutool",
      ["port"]
    ]
  ]);
});
