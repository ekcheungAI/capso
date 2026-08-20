import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const toast = readFileSync(new URL("../components/toast.tsx", import.meta.url), "utf8");

test("action receipts announce politely and expose a full-size named Undo", () => {
  assert.match(toast, /aria-live="polite"/);
  assert.match(toast, /aria-label="Recent actions"/);
  assert.match(toast, /role="group"/);
  assert.match(toast, /aria-label=\{t\.text\}/);
  assert.match(toast, /aria-label=\{`\$\{t\.label\}: \$\{t\.text\}`\}/);
  assert.match(toast, /className="min-h-11 shrink-0 px-1 font-medium underline underline-offset-2"/);
  assert.match(toast, /setTimeout\(\(\) => setToasts[\s\S]*, 5000\)/);
});
