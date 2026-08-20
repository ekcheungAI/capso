import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const thread = readFileSync(new URL("../app/threads/[id]/page.tsx", import.meta.url), "utf8");

test("project questions and cited answers remain touchable and announce updates", () => {
  assert.match(
    thread,
    /className="space-y-4 border-t border-line pt-5"\s+role="log"\s+aria-live="polite"\s+aria-label="Project conversation"/,
  );
  assert.match(
    thread,
    /className="min-h-11 flex-1 rounded-lg border border-line bg-surface px-4 text-sm"/,
  );
  assert.match(
    thread,
    /className="min-h-11 rounded-lg bg-accent px-4 text-xs font-medium text-accent-ink disabled:opacity-40"/,
  );
  assert.match(thread, /aria-label=\{`Open source \$\{shot\.title\}`\}/);
  assert.match(
    thread,
    /className="mx-1 inline-flex min-h-11 items-center rounded border border-line px-2 align-middle text-xs text-muted hover:border-accent"/,
  );
});
