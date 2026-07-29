import assert from "node:assert/strict";
import test from "node:test";
import { parsePopulationCapacity } from "../src/vision.mjs";

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
