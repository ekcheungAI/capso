import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const library = readFileSync(new URL("../app/library/page.tsx", import.meta.url), "utf8");
const ui = readFileSync(new URL("../components/ui.tsx", import.meta.url), "utf8");

test("capture-card selection and filing actions name the exact capture", () => {
  assert.match(ui, /aria-label=\{selected \? `Deselect \$\{s\.title\}` : `Select \$\{s\.title\}`\}/);
  assert.match(ui, /aria-label=\{`Confirm \$\{s\.title\} in \$\{suggestion\.label\}`\}/);
  assert.match(ui, /aria-label=\{`Move \$\{s\.title\} to a different project`\}/);
});

test("Library announces result changes and gives move and shelf navigation exact context", () => {
  assert.match(
    library,
    /role="status" aria-live="polite" aria-atomic="true">\s*\{results\.length\}/,
  );
  assert.match(library, /role="group"\s+aria-label=\{`Move \$\{selected\.size\} selected captures`\}/);
  assert.match(
    library,
    /href=\{`\/threads\/\$\{thread\.id\}`\} className="inline-flex min-h-11 items-center hover:underline"/,
  );
});
