import test from "node:test";
import assert from "node:assert/strict";
import { AdbClient } from "../src/adb.mjs";

test("every ADB key resets mouse state before sending the key event", async () => {
  const calls = [];
  const adb = createAdb(calls);

  await adb.key("KEYCODE_M");

  assert.deepEqual(calls, [
    ["input", "mouse", "motionevent", "UP", "960", "600"],
    ["input", "keyevent", "KEYCODE_M"]
  ]);
});

test("every ADB key combination resets mouse state first", async () => {
  const calls = [];
  const adb = createAdb(calls);

  await adb.keyCombination(["KEYCODE_CTRL_LEFT", "KEYCODE_Q"]);

  assert.deepEqual(calls, [
    ["input", "mouse", "motionevent", "UP", "960", "600"],
    [
      "input",
      "keycombination",
      "KEYCODE_CTRL_LEFT",
      "KEYCODE_Q"
    ]
  ]);
});

test("a failed ADB mouse reset blocks the key instead of pretending it was focused", async () => {
  const calls = [];
  const adb = createAdb(calls, true);

  await assert.rejects(adb.key("KEYCODE_W"), /mouse reset failed/);
  assert.equal(
    calls.some((args) => args.includes("keyevent")),
    false
  );
});

test("ADB movement focus uses hover and release without a click", async () => {
  const calls = [];
  const adb = createAdb(calls);

  await adb.focusGameInput(960, 600);

  assert.deepEqual(calls, [
    ["input", "mouse", "motionevent", "HOVER_MOVE", "960", "600"],
    ["input", "mouse", "motionevent", "UP", "960", "600"]
  ]);
  assert.equal(calls.some((args) => args.includes("tap")), false);
});

function createAdb(calls, failReset = false) {
  const adb = new AdbClient({
    adb: {
      binary: "adb",
      serial: "127.0.0.1:16480",
      screenWidth: 1920,
      screenHeight: 1200
    }
  });
  adb.shell = async (args) => {
    const normalized = args.map(String);
    calls.push(normalized);
    if (failReset && normalized.includes("motionevent")) {
      throw new Error("mouse reset failed");
    }
    return { stdout: "", stderr: "" };
  };
  return adb;
}
