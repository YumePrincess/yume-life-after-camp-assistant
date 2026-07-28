import test from "node:test";
import assert from "node:assert/strict";
import {
  descendingTeamSlots,
  parsePatrolKickCommand
} from "../src/workflows/patrol.mjs";

test("a full patrol command is normalized and kicked from back to front", () => {
  assert.deepEqual(parsePatrolKickCommand("T2345678"), {
    text: "T2345678",
    slots: [8, 7, 6, 5, 4, 3, 2],
    refused: false
  });
});

test("a sparse patrol command is kicked from back to front", () => {
  assert.deepEqual(descendingTeamSlots("T256"), [6, 5, 2]);
});

test("duplicate slots are only processed once", () => {
  assert.deepEqual(descendingTeamSlots("T22566"), [6, 5, 2]);
});

test("lowercase and copied whitespace are normalized", () => {
  assert.deepEqual(parsePatrolKickCommand("  t 2 5 6 \n"), {
    text: "T256",
    slots: [6, 5, 2],
    refused: false
  });
});

test("any command containing slot one is refused as a whole", () => {
  assert.deepEqual(parsePatrolKickCommand("T1"), {
    text: "T1",
    slots: [],
    refused: true
  });
  assert.deepEqual(parsePatrolKickCommand("T128"), {
    text: "T128",
    slots: [],
    refused: true
  });
});

test("only an exact T command containing slots one through eight is accepted", () => {
  for (const invalid of [
    "",
    "T",
    "T9",
    "XT256",
    "T256!",
    "请T256",
    "T2abc"
  ]) {
    assert.equal(parsePatrolKickCommand(invalid), null);
  }
});
