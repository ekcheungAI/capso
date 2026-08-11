import assert from "node:assert/strict";
import test from "node:test";
import { deriveDeviceToken } from "./device.ts";

test("account-scoped extension codes are stable and owner-specific", async () => {
  const browserSecret = "d_0123456789abcdefghij";
  const ownerA = await deriveDeviceToken(browserSecret, "00000000-0000-4000-8000-000000000001");
  const ownerAAgain = await deriveDeviceToken(browserSecret, "00000000-0000-4000-8000-000000000001");
  const ownerB = await deriveDeviceToken(browserSecret, "00000000-0000-4000-8000-000000000002");

  assert.equal(ownerA, ownerAAgain);
  assert.notEqual(ownerA, ownerB);
  assert.match(ownerA, /^d_[A-Za-z0-9_-]{32}$/);
});

test("local-only extension pairing keeps the existing browser code", async () => {
  const browserSecret = "d_0123456789abcdefghij";
  assert.equal(await deriveDeviceToken(browserSecret, null), browserSecret);
});

