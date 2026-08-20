import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../app/memory/page.tsx", import.meta.url), "utf8");
const provider = readFileSync(new URL("store/provider.tsx", import.meta.url), "utf8");
const store = readFileSync(new URL("store/index.ts", import.meta.url), "utf8");

test("Memory exposes evidence and a reversible stop-teaching action", () => {
  assert.match(page, /memoryRuleSummary\(corrections, screenshots\)/);
  assert.match(page, /Project suggestions accepted/);
  assert.match(page, /agreement rate, not model confidence/);
  assert.match(page, /Based on/);
  assert.match(page, /await forget\(c\.id\)/);
  assert.match(page, /Stopped using this example for future guesses/);
  assert.match(page, /void rememberCorrection\(c\)/);
  assert.match(provider, /rememberCorrection: \(correction: Correction\) => Promise<boolean>/);
  assert.match(store, /export async function restoreCorrection\(correction: Correction\)/);
  assert.match(store, /get<Screenshot>\("screenshots", correction\.screenshotId\)/);
});
