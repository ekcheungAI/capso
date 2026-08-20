import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const review = readFileSync(new URL("../app/review/page.tsx", import.meta.url), "utf8");

test("Review hides desktop shortcuts on phones and keeps every decision target at 44px", () => {
  assert.match(review, /className="hidden text-xs sm:inline">j\/k move/);
  assert.match(review, /className="min-h-11 rounded-md bg-accent px-3 text-xs font-medium text-accent-ink disabled:opacity-40"/);
  assert.match(review, /className="min-h-11 rounded-md bg-accent px-3 text-xs font-medium text-accent-ink"/);
  assert.match(review, /aria-label=\{`Move \$\{s\.title\} to a different project`\}/);
  assert.match(review, /className="min-h-11 rounded-md border border-line bg-surface px-2 text-xs"/);
  assert.doesNotMatch(review, /className="text-xs">j\/k move/);
});
