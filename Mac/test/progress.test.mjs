import test from "node:test";
import assert from "node:assert/strict";
import { createRoutineWorkflow } from "../src/workflows/routine.mjs";
import {
  progressForRange,
  progressRangeSlice,
  updateWorkflowProgress
} from "../src/workflows/progress.mjs";

test("progress ranges interpolate by completed steps", () => {
  assert.equal(progressForRange(0.1, 0.7, 0, 4), 0.1);
  assert.equal(progressForRange(0.1, 0.7, 2, 4), 0.4);
  assert.equal(progressForRange(0.1, 0.7, 8, 4), 0.7);
  const sliced = progressRangeSlice({ start: 0.2, end: 0.8 }, 0.25);
  assert.ok(Math.abs(sliced.start - 0.35) < 1e-9);
  assert.equal(sliced.end, 0.8);
});

test("workflow progress ignores missing values and clamps progress", async () => {
  const values = [];
  const context = {
    async progress(value, step) {
      values.push({ value, step });
    }
  };
  await updateWorkflowProgress(context, undefined, "missing");
  await updateWorkflowProgress(context, -1, "low");
  await updateWorkflowProgress(context, 1.2, "high");
  assert.deepEqual(values, [
    { value: 0.02, step: "low" },
    { value: 0.99, step: "high" }
  ]);
});

test("routine progress allocates a monotonic range to each serialized task", async () => {
  const values = [];
  const context = {
    async report() {},
    async progress(value, step) {
      values.push({ value, step });
    }
  };
  const routine = createRoutineWorkflow({
    first: async (taskContext) => taskContext.progress(0.5, "first_half"),
    second: async (taskContext) => taskContext.progress(0.5, "second_half")
  });
  await routine(
    context,
    { payload: { detail: { routine: { name: "test", groups: [["first"], ["second"]] } } } },
    {},
    undefined
  );
  const mapped = values.map(({ value }) => value);
  assert.equal(mapped.length, 4);
  assert.ok(Math.abs(mapped[0] - 0.2551) < 1e-4);
  assert.equal(mapped[1], 0.5);
  assert.ok(Math.abs(mapped[2] - 0.7351) < 1e-4);
  assert.equal(mapped[3], 0.98);
});
