import assert from "node:assert/strict";
import test from "node:test";
import { overlaySyncPresentation, type CaptureSyncStatus } from "./overlay-sync.ts";

function present(status: CaptureSyncStatus["status"]) {
  return overlaySyncPresentation({ status });
}

test("Quick Access explains that sync starts only after its edit hold closes", () => {
  const presentation = present("ready");

  assert.equal(presentation.copy, "Ready to sync");
  assert.match(presentation.detail, /after Quick Access closes/i);
});

test("retry and terminal failure states preserve the local-safety promise", () => {
  const retry = present("retrying");
  const attention = present("needs_attention");

  assert.match(retry.detail, /original is safe/i);
  assert.equal(retry.tone, "neutral");
  assert.match(attention.detail, /original is safe/i);
  assert.equal(attention.tone, "warning");
});

test("only a remote acknowledgement reads as synced", () => {
  assert.equal(present("waiting").copy, "Waiting to sync");
  assert.equal(present("syncing").copy, "Syncing now");
  assert.equal(present("synced").copy, "Synced to library");
  assert.equal(present("synced").tone, "ready");
});

test("an unavailable queue never implies that the local original was lost", () => {
  const presentation = present("unavailable");

  assert.equal(presentation.copy, "Saved on this Mac");
  assert.match(presentation.detail, /original remains safely stored here/i);
  assert.equal(presentation.tone, "warning");
});
