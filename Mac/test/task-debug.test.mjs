import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { TaskDebugArtifacts } from "../src/task-debug.mjs";

test("debug evidence publishes complete masked images atomically", async () => {
  const rootDirectory = await mkdtemp(resolve(tmpdir(), "yla-task-debug-"));
  const sourcePath = resolve(rootDirectory, "masked.png");
  const artifacts = new TaskDebugArtifacts({
    runId: "run-with-masks",
    taskKey: "member_profile_sync",
    rootDirectory
  });

  try {
    await writeFile(sourcePath, "complete masked image");
    await artifacts.start();
    const debugPath = await artifacts.recordImage(
      sourcePath,
      "member-details-avatar-column-masked"
    );

    assert.ok(debugPath);
    assert.equal(
      await readFile(debugPath, "utf8"),
      "complete masked image"
    );
    assert.deepEqual(
      (await readdir(artifacts.taskDirectory)).filter((name) =>
        name.endsWith(".partial")
      ),
      []
    );
    assert.deepEqual(
      (await readdir(artifacts.taskDirectory)).filter((name) =>
        name.endsWith(".png")
      ),
      ["0001-member-details-avatar-column-masked.png"]
    );
    const imageIndex = (await readFile(
      resolve(artifacts.taskDirectory, "images.jsonl"),
      "utf8"
    )).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(imageIndex.length, 1);
    assert.equal(imageIndex[0].sequence, 1);
    assert.equal(imageIndex[0].label, "member-details-avatar-column-masked");
    assert.equal(imageIndex[0].fileName, "0001-member-details-avatar-column-masked.png");
    assert.ok(Number.isFinite(Date.parse(imageIndex[0].capturedAt)));
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});
