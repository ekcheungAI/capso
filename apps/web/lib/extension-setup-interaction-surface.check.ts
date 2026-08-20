import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const extension = readFileSync(new URL("../app/extension/page.tsx", import.meta.url), "utf8");
const account = readFileSync(new URL("../components/account-gate.tsx", import.meta.url), "utf8");

test("extension download and device-code copy expose full-size explicit feedback", () => {
  assert.match(
    extension,
    /className="inline-flex min-h-11 items-center rounded-lg bg-accent px-4 text-xs font-medium text-accent-ink"/,
  );
  assert.match(extension, /<span className="sr-only" role="status" aria-live="polite">/);
  assert.match(extension, /Device code copied\./);
  assert.match(extension, /role="alert"[^>]*>Could not copy the device code\. Select it manually instead\./);
});

test("failed extension and account setup can retry through a 44px action", () => {
  assert.match(extension, /async function pairExtensionDevice\(deviceToken: string\)/);
  assert.match(extension, /onClick=\{\(\) => void retryPairing\(\)\}/);
  assert.match(
    extension,
    /className="mt-2 min-h-11 rounded-lg border border-line px-3 text-xs font-semibold"[^>]*>\s*Retry secure pairing/,
  );
  assert.match(
    account,
    /className="mt-6 min-h-11 rounded-xl bg-accent px-4 text-sm font-semibold text-accent-ink"/,
  );
});
