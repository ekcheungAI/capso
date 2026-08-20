import assert from "node:assert/strict";
import test from "node:test";
import {
  EXTENSION_DEVICE_ID,
  EXTENSION_DEVICE_TOKEN,
  extensionDeviceActivity,
  extensionDeviceHash,
} from "./extension-device.ts";

test("extension device codes have one stable, non-reversible database identity", async () => {
  const token = "d_0123456789abcdef0123456789abcdef";
  assert.ok(EXTENSION_DEVICE_TOKEN.test(token));
  assert.equal(await extensionDeviceHash(token), await extensionDeviceHash(token));
  assert.match(await extensionDeviceHash(token), /^[0-9a-f]{64}$/);
  assert.notEqual(await extensionDeviceHash(token), token);
  assert.ok(!EXTENSION_DEVICE_TOKEN.test("device-anything"));
});

test("device management validates ids and explains never-used or recently-used connections", () => {
  const id = "33333333-3333-4333-8333-333333333333";
  assert.ok(EXTENSION_DEVICE_ID.test(id));
  assert.ok(!EXTENSION_DEVICE_ID.test("../../../other-owner"));
  assert.equal(extensionDeviceActivity({
    id,
    label: "Chrome extension",
    createdAt: "2026-08-12T12:00:00.000Z",
    lastSeenAt: null,
    lastCaptureAt: null,
  }), "Ready · no captures delivered yet");
  assert.match(extensionDeviceActivity({
    id,
    label: "Chrome extension",
    createdAt: "2026-08-12T12:00:00.000Z",
    lastSeenAt: "2026-08-12T13:00:00.000Z",
    lastCaptureAt: "2026-08-12T13:00:00.000Z",
  }), /^Last delivered /);
});
