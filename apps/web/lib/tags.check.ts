import assert from "node:assert/strict";
import test from "node:test";
import { allTags, tagCounts, tagVocabulary } from "./tags.ts";
import { shot } from "./check-fixtures.ts";

test("owner tags come first and duplicates collapse", () => {
  const s = shot({ id: "a", tags: ["pricing", "stripe"], userTags: ["swipe", "pricing"] });
  assert.deepEqual(allTags(s), ["swipe", "pricing", "stripe"]);
});

test("counts span both tag arrays and skip archived captures", () => {
  const rows = [
    shot({ id: "a", tags: ["pricing"] }),
    shot({ id: "b", userTags: ["pricing"] }),
    shot({ id: "c", tags: ["pricing"], archived: true }),
    shot({ id: "d", tags: ["onboarding"] }),
  ];
  assert.deepEqual(tagCounts(rows), [
    ["pricing", 2],
    ["onboarding", 1],
  ]);
});

test("ties break alphabetically so the list does not reshuffle between renders", () => {
  const rows = [shot({ id: "a", tags: ["zebra", "apple"] })];
  assert.deepEqual(
    tagCounts(rows).map(([t]) => t),
    ["apple", "zebra"],
  );
});

test("vocabulary excludes tags used only once", () => {
  // A tag seen once is not yet vocabulary; offering it back to the model would
  // cement whatever it happened to say the first time.
  const rows = [
    shot({ id: "a", tags: ["pricing", "one-off"] }),
    shot({ id: "b", tags: ["pricing"] }),
  ];
  assert.deepEqual(tagVocabulary(rows), ["pricing"]);
});

test("vocabulary is capped and ordered by use", () => {
  const rows = [
    shot({ id: "a", tags: ["common", "rare"] }),
    shot({ id: "b", tags: ["common", "rare"] }),
    shot({ id: "c", tags: ["common"] }),
  ];
  assert.deepEqual(tagVocabulary(rows, 1), ["common"]);
});
