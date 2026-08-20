import assert from "node:assert/strict";
import test from "node:test";
import { CaptureCoordinator } from "./capture-coordinator.js";

test("one long capture blocks an overlapping viewport or full-page capture", async () => {
  const coordinator = new CaptureCoordinator();
  let release;
  const first = coordinator.run(() => new Promise((resolve) => {
    release = () => resolve({ ok: true });
  }));

  assert.deepEqual(await coordinator.run(async () => ({ ok: true })), {
    ok: false,
    message: "Another capture is already in progress.",
  });
  release();
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(await coordinator.run(async () => ({ ok: true })), { ok: true });
});

test("a thrown capture always releases the single-flight lease", async () => {
  const coordinator = new CaptureCoordinator();

  await assert.rejects(coordinator.run(async () => {
    throw new Error("injected capture failure");
  }));
  assert.deepEqual(await coordinator.run(async () => ({ ok: true })), { ok: true });
});
