import assert from "node:assert/strict";
import test from "node:test";
import { threadRailPresentation } from "./thread-rail.ts";

test("an uncited rail names a truncated project list as a preview", () => {
  assert.deepEqual(threadRailPresentation(8, 0), {
    heading: "Project preview · 2 of 8",
    ariaLabel: "Showing 2 of 8 captures in this project",
  });
});

test("an uncited rail does not call a complete project list a preview", () => {
  assert.deepEqual(threadRailPresentation(2, 0), {
    heading: "In this project · 2",
    ariaLabel: "All 2 captures in this project",
  });
  assert.deepEqual(threadRailPresentation(1, 0), {
    heading: "In this project · 1",
    ariaLabel: "The capture in this project",
  });
});

test("citations identify the latest answer instead of claiming to be the project total", () => {
  assert.deepEqual(threadRailPresentation(8, 3), {
    heading: "Latest answer sources · 3",
    ariaLabel: "3 sources cited by the latest answer",
  });
  assert.deepEqual(threadRailPresentation(8, 1), {
    heading: "Latest answer source · 1",
    ariaLabel: "1 source cited by the latest answer",
  });
});

test("invalid or empty counts fail closed to an empty project rail", () => {
  assert.deepEqual(threadRailPresentation(-1, Number.NaN), {
    heading: "In this project · 0",
    ariaLabel: "No captures in this project",
  });
});
