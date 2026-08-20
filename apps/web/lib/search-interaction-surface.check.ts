import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const search = readFileSync(new URL("../app/search/page.tsx", import.meta.url), "utf8");
const ui = readFileSync(new URL("../components/ui.tsx", import.meta.url), "utf8");

test("Search announces answer state and keeps cited sources touchable and named", () => {
  assert.match(
    search,
    /<p className="sr-only" role="status" aria-live="polite" aria-atomic="true">/,
  );
  assert.match(search, /Answer ready\. \$\{plural\(answer\.cited\.length, "capture"\)\} cited\./);
  assert.match(search, /aria-label=\{`Open source \$\{shot\.title\}`\}/);
  assert.match(
    search,
    /className="mx-1 inline-flex min-h-11 items-center gap-1 rounded border border-line px-2 align-middle text-xs text-muted transition-colors duration-\[120ms\] hover:border-accent hover:text-foreground"/,
  );
});

test("shared empty-state links and buttons retain a 44px action target", () => {
  assert.match(ui, /\[&_a\]:inline-flex \[&_a\]:min-h-11 \[&_a\]:items-center/);
  assert.match(ui, /\[&_button\]:min-h-11/);
});
