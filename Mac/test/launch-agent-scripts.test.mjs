import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const runFile = promisify(execFile);

test("LaunchAgent repair waits through an in-progress launchd removal", async () => {
  const fixture = await mkdtemp(resolve(tmpdir(), "yla-launch-agent-test-"));
  const home = resolve(fixture, "home");
  const bin = resolve(fixture, "bin");
  const state = resolve(fixture, "state");
  await Promise.all([mkdir(home), mkdir(bin), mkdir(state)]);

  const launchctl = resolve(bin, "launchctl");
  await writeFile(
    launchctl,
    `#!/bin/zsh
set -eu
state=\${FAKE_LAUNCHCTL_STATE:?}
command=\${1:-}
target=\${2:-}
case "\${command}" in
  bootout)
    [[ "\${target}" == *"zone.yume.lifeafter.macagent.runtime" ]] && rm -f "\${state}/loaded"
    exit 0
    ;;
  bootstrap)
    count=0
    [[ -f "\${state}/bootstrap-count" ]] && count=$(<"\${state}/bootstrap-count")
    count=$((count + 1))
    print -r -- "\${count}" > "\${state}/bootstrap-count"
    if (( count < 4 )); then
      print -u2 -- "Bootstrap failed: 37: Operation already in progress"
      exit 37
    fi
    touch "\${state}/loaded"
    exit 0
    ;;
  print)
    [[ -f "\${state}/loaded" ]] || exit 113
    print -r -- $'\tstate = running'
    print -r -- $'\tpid = 4242'
    exit 0
    ;;
  kickstart)
    [[ -f "\${state}/loaded" ]]
    exit
    ;;
esac
exit 2
`,
    { mode: 0o755 }
  );
  await chmod(launchctl, 0o755);

  const script = resolve("scripts/install-launch-agent.sh");
  const result = await runFile(script, [], {
    cwd: resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_LAUNCHCTL_STATE: state
    },
    timeout: 15_000
  });

  assert.match(result.stdout, /running \(pid 4242\)/);
  assert.equal((await readFile(resolve(state, "bootstrap-count"), "utf8")).trim(), "4");
  const plist = await readFile(
    resolve(home, "Library/LaunchAgents/zone.yume.lifeafter.macagent.runtime.plist"),
    "utf8"
  );
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<false\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<false\/>/);
});
