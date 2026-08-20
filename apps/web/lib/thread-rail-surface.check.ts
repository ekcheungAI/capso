import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../app/threads/[id]/page.tsx", import.meta.url), "utf8");

test("the project rail renders its count contract as visible and accessible copy", () => {
  assert.match(page, /threadRailPresentation\(shots\.length, lastCited\.length\)/);
  assert.match(page, /aria-label=\{railPresentation\.ariaLabel\}/);
  assert.match(page, /\{railPresentation\.heading\}/);
  assert.doesNotMatch(page, /`In this project · \$\{rail\.length\}`/);
  assert.doesNotMatch(page, /`Sources · \$\{rail\.length\}`/);
});
