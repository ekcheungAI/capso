import assert from "node:assert/strict";
import test from "node:test";
import { extensionCaptureId, shouldStartExtensionPoll } from "./extension-poll.ts";

test("extension polling ignores focus storms inside the regular polling cadence", () => {
  assert.equal(shouldStartExtensionPoll(10_000, Number.NEGATIVE_INFINITY), true);
  assert.equal(shouldStartExtensionPoll(10_100, 10_000), false);
  assert.equal(shouldStartExtensionPoll(12_499, 10_000), false);
  assert.equal(shouldStartExtensionPoll(12_500, 10_000), true);
});

test("legacy extension outbox ids become stable Postgres UUIDs", () => {
  const legacy = "c_mepm6y1a123456789abc";
  assert.match(extensionCaptureId(legacy), /^[0-9a-f-]{36}$/);
  assert.equal(extensionCaptureId(legacy), extensionCaptureId(legacy));

  const uuid = "11111111-1111-4111-8111-111111111111";
  assert.equal(extensionCaptureId(uuid), uuid);
});
