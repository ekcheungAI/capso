import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const devices = readFileSync(new URL("../components/devices-sync.tsx", import.meta.url), "utf8");

test("device loading can retry through one cancellable request path", () => {
  assert.match(devices, /const loadDevices = useCallback\(async \(signal\?: AbortSignal\)/);
  assert.match(devices, /const controller = new AbortController\(\)/);
  assert.match(devices, /window\.setTimeout\(\(\) => void loadDevices\(controller\.signal\), 0\)/);
  assert.match(devices, /controller\.abort\(\)/);
  assert.match(devices, /onClick=\{\(\) => void loadDevices\(\)\}/);
  assert.match(
    devices,
    /className="mt-2 min-h-11 rounded-lg border border-line px-3 text-xs font-semibold"/,
  );
});

test("device revocation is single-flight and announces exact retained-data feedback", () => {
  assert.match(devices, /if \(revokeRequest\.current\) return;\s*revokeRequest\.current = true;/);
  assert.match(devices, /disabled=\{revoking !== null\}/);
  assert.match(devices, /setNotice\(`\$\{device\.label\} disconnected\. Existing captures remain in \$\{email\}\.`\)/);
  assert.match(devices, /role="status" aria-live="polite"/);
  assert.match(devices, /finally \{[\s\S]*revokeRequest\.current = false;/);
});
