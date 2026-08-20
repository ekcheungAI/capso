import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const home = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");

test("Home keeps compact navigation touchable and names repeated project actions", () => {
  assert.match(
    home,
    /href="\/inbox" className="inline-flex min-h-11 items-center px-2 text-xs font-medium text-muted hover:text-foreground">\s*Review all/,
  );
  assert.match(
    home,
    /href="\/library" className="mt-2 inline-flex min-h-11 items-center gap-2 px-2 text-xs font-medium text-muted hover:text-foreground">\s*Browse all projects/,
  );
  assert.match(
    home,
    /href=\{`\/threads\/\$\{thread\.id\}`\} className="inline-flex min-h-11 items-center text-sm font-semibold hover:underline">\{thread\.name\}<\/Link>/,
  );
  assert.match(home, /aria-label=\{`Open \$\{thread\.name\}`\}/);
  assert.match(
    home,
    /className="inline-flex min-h-11 items-center justify-center text-center text-xs font-semibold text-muted hover:text-foreground"\s*>Open<\/Link>/,
  );
});
