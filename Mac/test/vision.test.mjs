import assert from "node:assert/strict";
import test from "node:test";
import { parsePopulationCount } from "../src/vision.mjs";

test("parses the current member count instead of the capacity", () => {
  assert.equal(
    parsePopulationCount(
      [{ text: "9/96", x: 350 }, { text: "（", x: 420 }],
      110
    ),
    9
  );
  assert.equal(
    parsePopulationCount([{ text: "102/110", x: 350 }], 110),
    102
  );
});

test("accepts zero current citizens and split OCR fragments", () => {
  assert.equal(
    parsePopulationCount(
      [
        { text: "0/", x: 475 },
        { text: "5（", x: 500 }
      ],
      10
    ),
    0
  );
  assert.equal(
    parsePopulationCount([{ text: "6／10", x: 475 }], 10),
    6
  );
});

test("rejects icon-contaminated and impossible counts", () => {
  assert.equal(
    parsePopulationCount([{ text: "全部成员89/96", x: 100 }], 10),
    null
  );
  assert.equal(
    parsePopulationCount([{ text: "12/10", x: 475 }], 10),
    null
  );
});
