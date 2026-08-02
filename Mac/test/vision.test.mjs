import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePopulationCapacity,
  safeSipsCropRegion
} from "../src/vision.mjs";

test("macOS 27 bottom-edge crops shift inward instead of silently returning the full frame", () => {
  assert.deepEqual(
    safeSipsCropRegion(
      { left: 0, top: 980, right: 760, bottom: 1200 },
      1920,
      1200
    ),
    { left: 0, top: 979, width: 760, height: 220, adjusted: true }
  );
  assert.deepEqual(
    safeSipsCropRegion(
      { left: 100, top: 200, right: 500, bottom: 600 },
      1920,
      1200
    ),
    { left: 100, top: 200, width: 400, height: 400, adjusted: false }
  );
});

test("parses total members from the fraction denominator", () => {
  assert.equal(
    parsePopulationCapacity(
      [{ text: "9/96", x: 350 }, { text: "（", x: 420 }],
      110
    ),
    96
  );
  assert.equal(
    parsePopulationCapacity([{ text: "102/110", x: 350 }], 110),
    110
  );
});

test("accepts zero online citizens and split OCR fragments", () => {
  assert.equal(
    parsePopulationCapacity(
      [
        { text: "0/", x: 475 },
        { text: "5（", x: 500 }
      ],
      10
    ),
    5
  );
  assert.equal(
    parsePopulationCapacity([{ text: "6／10", x: 475 }], 10),
    10
  );
});

test("rejects icon-contaminated and impossible counts", () => {
  assert.equal(
    parsePopulationCapacity([{ text: "全部成员89/96", x: 100 }], 10),
    null
  );
  assert.equal(
    parsePopulationCapacity([{ text: "12/10", x: 475 }], 10),
    null
  );
});
