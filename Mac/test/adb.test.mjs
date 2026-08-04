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

test("ADB movement focus uses supported MOVE and release without a click", async () => {
  const calls = [];
  const adb = createAdb(calls);

  await adb.focusGameInput(960, 600);

  assert.deepEqual(calls, [
    ["input", "mouse", "motionevent", "MOVE", "960", "600"],
    ["input", "mouse", "motionevent", "UP", "960", "600"]
  ]);
  assert.equal(calls.some((args) => args.includes("tap")), false);
});

test("an Android build without MOVE support falls back to mouse UP and continues", async () => {
  const calls = [];
  const adb = createAdb(calls);
  adb.shell = async (args) => {
    const normalized = args.map(String);
    calls.push(normalized);
    if (normalized.includes("MOVE")) {
      throw new Error("IllegalArgumentException: Unknown action: MOVE");
    }
    return { stdout: "", stderr: "" };
  };

  await adb.focusGameInput(1782, 128);

  assert.deepEqual(calls, [
    ["input", "mouse", "motionevent", "MOVE", "1782", "128"],
    ["input", "mouse", "motionevent", "UP", "1782", "128"]
  ]);
});

test("mouse injection permission denial does not block supported keyboard commands", async () => {
  const calls = [];
  const adb = createAdb(calls);
  adb.shell = async (args) => {
    const normalized = args.map(String);
    calls.push(normalized);
    if (normalized.includes("motionevent")) {
      throw new Error(
        "SecurityException: Injecting to another application requires INJECT_EVENTS permission"
      );
    }
    return { stdout: "", stderr: "" };
  };

  assert.equal(await adb.focusGameInput(1782, 128), false);
  await adb.key("KEYCODE_M");

  assert.deepEqual(calls, [
    ["input", "mouse", "motionevent", "MOVE", "1782", "128"],
    ["input", "mouse", "motionevent", "UP", "960", "600"],
    ["input", "keyevent", "KEYCODE_M"]
  ]);
});

test("ADB touch tap bypasses the mouse source and releases stale mouse state", async () => {
  const calls = [];
  const adb = createAdb(calls);

  await adb.touchTap(190, 180);

  assert.deepEqual(calls, [
    ["input", "tap", "190", "180"],
    ["input", "mouse", "motionevent", "UP", "190", "180"]
  ]);
});

test("ADB touch swipe performs the calibrated held joystick drag", async () => {
  const calls = [];
  const adb = createAdb(calls);

  await adb.touchSwipe({ x: 480, y: 600 }, { x: 480, y: 360 }, 1_500);

  assert.deepEqual(calls, [
    ["input", "swipe", "480", "600", "480", "360", "1500"]
  ]);
});

test("ADB held W uses container key down and up events", async () => {
  const calls = [];
  const adb = createAdb(calls);
  adb.keyboardInputDevice = "/dev/input/event2";

  await adb.holdKey("KEYCODE_W", 100);

  assert.deepEqual(calls, [
    ["sendevent", "/dev/input/event2", "1", "17", "1"],
    ["sendevent", "/dev/input/event2", "0", "0", "0"],
    ["sendevent", "/dev/input/event2", "1", "17", "0"],
    ["sendevent", "/dev/input/event2", "0", "0", "0"]
  ]);
});

test("first ADB mouse click summons the game cursor with KEYCODE_GRAVE once", async () => {
  const calls = [];
  const adb = createAdb(calls);

  await adb.prepareGameMouseForClick();
  await adb.prepareGameMouseForClick();

  assert.deepEqual(calls, [
    ["input", "mouse", "motionevent", "UP", "960", "600"],
    ["input", "keyevent", "KEYCODE_GRAVE"]
  ]);
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
