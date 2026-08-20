import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const firstRun = readFileSync(new URL("../components/first-run.tsx", import.meta.url), "utf8");
const account = readFileSync(new URL("../components/account-gate.tsx", import.meta.url), "utf8");

test("first-run setup announces progress and recovers every failed choice", () => {
  assert.match(firstRun, /try \{\s*await setup\(\)/);
  assert.match(firstRun, /catch \{\s*setError\("Couldn’t finish setup\. Try that choice again\."\)/);
  assert.match(firstRun, /finally \{\s*setBusy\(null\)/);
  assert.match(firstRun, /role="status" aria-live="polite"/);
  assert.match(firstRun, /role="alert"/);
});

test("account loading is announced and email-link submission is true single-flight", () => {
  assert.match(account, /if \(emailRequest\.current\) return;\s*emailRequest\.current = true;/);
  assert.match(account, /finally \{[\s\S]*emailRequest\.current = false;/);
  assert.match(account, /<form\s+className="mt-6"\s+aria-busy=\{sending\}/);
  assert.match(account, /aria-label=\{sending \? "Sending sign-in link" : "Send sign-in link"\}/);
  assert.match(account, /role="status" aria-live="polite"[^>]*>\s*<SpinnerGap/);
});
