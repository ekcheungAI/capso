import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const detail = readFileSync(new URL("../app/s/[id]/page.tsx", import.meta.url), "utf8");

test("capture filmstrip links name their destination and current position", () => {
  assert.match(
    detail,
    /aria-label=\{`Open \$\{n\.title\}\$\{n\.id === s\.id \? ", current capture" : ""\}`\}/,
  );
  assert.match(detail, /aria-current=\{n\.id === s\.id \? "page" : undefined\}/);
});

test("capture and share feedback is announced and repeated controls stay exact", () => {
  assert.match(detail, /\{copied && <span role="status" aria-live="polite" className="text-muted">Copied \{copied\}<\/span>\}/);
  assert.match(
    detail,
    /className="ml-auto grid h-11 w-11 shrink-0 place-items-center rounded-full border border-line disabled:opacity-50"/,
  );
  assert.match(
    detail,
    /aria-label=\{`Revoke link expiring \$\{new Date\(link\.expiresAt\)\.toLocaleString\("en-GB"\)\}`\}/,
  );
  assert.match(detail, /className="min-h-11 rounded-lg px-3 font-semibold text-danger disabled:opacity-50"/);
});
