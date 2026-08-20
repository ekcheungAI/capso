import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const memory = readFileSync(new URL("../app/memory/page.tsx", import.meta.url), "utf8");

test("every Memory tab and compact action has a 44px touch target", () => {
  assert.match(memory, /className=\{`-mb-px min-h-11 border-b-2 px-3 text-xs/);
  assert.equal(memory.match(/min-h-11/g)?.length, 8);
});
