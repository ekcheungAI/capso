import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const receiver = readFileSync(new URL("../app/share/page.tsx", import.meta.url), "utf8");

test("password delivery is single-flight and exposes its busy state", () => {
  assert.match(receiver, /status: "password"; details: ShareInspectResult; error: string \| null; busy: boolean/);
  assert.match(receiver, /if \(imageRequest\.current\) return;\s*imageRequest\.current = true;/);
  assert.match(receiver, /finally \{\s*imageRequest\.current = false;\s*\}/);
  assert.match(receiver, /current\.status === "password"\s*\? \{ \.\.\.current, error: null, busy: true \}/);
  assert.match(receiver, /if \(token && !receiverState\.busy\) void loadImage/);
  assert.match(receiver, /disabled=\{receiverState\.busy\}/);
  assert.match(receiver, /\{receiverState\.busy \? "Opening…" : "Open capture"\}/);
});

test("receiver loading, recovery and download actions remain announced and touchable", () => {
  assert.match(receiver, /role="status"\s+aria-live="polite"\s+aria-label="Opening private capture"/);
  assert.match(receiver, /onClick=\{\(\) => window\.location\.reload\(\)\}/);
  assert.match(
    receiver,
    /className="mx-auto mt-6 min-h-11 rounded-xl border border-line px-5 text-sm font-semibold"/,
  );
  assert.match(
    receiver,
    /className="inline-flex min-h-11 items-center rounded-lg border border-line px-3 font-semibold text-foreground"/,
  );
});
