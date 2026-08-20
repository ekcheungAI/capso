import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { MAC_DEVICE_ID, macDeviceActivity } from "./mac-device.ts";

const id = "44444444-4444-4444-8444-444444444444";

test("Mac device rows use canonical ids and explain ready versus acknowledged sync", () => {
  assert.ok(MAC_DEVICE_ID.test(id));
  assert.ok(!MAC_DEVICE_ID.test("../another-device"));
  assert.equal(macDeviceActivity({
    id,
    label: "This Mac",
    platform: "macOS",
    appVersion: "0.1.0",
    createdAt: "2026-08-12T12:00:00.000Z",
    lastSeenAt: null,
    lastCaptureAt: null,
  }), "macOS · Capso 0.1.0 · ready");
  assert.match(macDeviceActivity({
    id,
    label: "Studio Mac",
    platform: "macOS",
    appVersion: "0.1.0",
    createdAt: "2026-08-12T12:00:00.000Z",
    lastSeenAt: "2026-08-12T13:00:00.000Z",
    lastCaptureAt: "2026-08-12T13:00:00.000Z",
  }), /^macOS · Capso 0\.1\.0 · Last synced /);
});

test("Mac device management is same-origin, account-authenticated and revokes through the owner RPC", () => {
  const source = readFileSync(
    new URL("../app/api/mac/devices/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /requireApiUser\(request\)/);
  assert.match(source, /isSameOrigin\(request\)/);
  assert.match(source, /\.eq\("user_id", account\.userId\)/);
  assert.match(source, /\.rpc\("revoke_mac_device", \{ p_device_id: id \}\)/);
  assert.doesNotMatch(source, /service_role/i);
});
