import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMembers,
  normalizeProfiles
} from "../src/table-parser.mjs";

test("similar member names are never fuzzy-merged", () => {
  const rows = normalizeMembers(
    [
      { name: "星河踏月归", materialContribution: 101 },
      { name: "星河踏月归✨", materialContribution: 202 }
    ],
    [
      { name: "星河踏月归", profession: "步枪兵王" },
      { name: "星河踏月归✨", profession: "武道大师" }
    ]
  );

  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map(({ name, profession, materialContribution }) => ({
      name,
      profession,
      materialContribution
    })),
    [
      {
        name: "星河踏月归",
        profession: "步枪兵王",
        materialContribution: 101
      },
      {
        name: "星河踏月归✨",
        profession: "武道大师",
        materialContribution: 202
      }
    ]
  );
});

test("member profiles retain weekly contribution for contribution cross-checking", () => {
  assert.deepEqual(
    normalizeProfiles([
      {
        name: "愿",
        profession: "步枪兵",
        weeklyContribution: "17,892,175"
      }
    ]),
    [
      {
        name: "愿",
        profession: "步枪兵",
        manorLevel: null,
        roommateName: null,
        campTitle: null,
        weeklyContribution: 17892175
      }
    ]
  );
});
