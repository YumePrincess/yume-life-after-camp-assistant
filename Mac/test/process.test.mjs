import assert from "node:assert/strict";
import test from "node:test";
import { delay } from "../src/process.mjs";

test("delay removes its abort listener after normal completion", async () => {
  const controller = new AbortController();
  const originalAdd = controller.signal.addEventListener.bind(controller.signal);
  const originalRemove = controller.signal.removeEventListener.bind(
    controller.signal
  );
  let added = 0;
  let removed = 0;
  controller.signal.addEventListener = (...args) => {
    added += 1;
    return originalAdd(...args);
  };
  controller.signal.removeEventListener = (...args) => {
    removed += 1;
    return originalRemove(...args);
  };

  await delay(1, controller.signal);

  assert.equal(added, 1);
  assert.equal(removed, 1);
});

test("delay removes its abort listener when interrupted", async () => {
  const controller = new AbortController();
  const originalRemove = controller.signal.removeEventListener.bind(
    controller.signal
  );
  let removed = 0;
  controller.signal.removeEventListener = (...args) => {
    removed += 1;
    return originalRemove(...args);
  };

  const pending = delay(10_000, controller.signal);
  controller.abort(new Error("test interruption"));

  await assert.rejects(pending, /test interruption/);
  assert.equal(removed, 1);
});
