import assert from "node:assert/strict";
import test from "node:test";

import { microphoneReadiness, type RecordingCapabilities } from "./recording-microphone.ts";

const authorized: RecordingCapabilities = {
  microphonePermission: "authorized",
  microphoneDevices: [
    { id: "built-in", name: "MacBook Microphone", isDefault: true },
    { id: "usb", name: "USB Microphone", isDefault: false },
  ],
};

test("microphone readiness distinguishes permission, disconnect, and no-device recovery", () => {
  assert.deepEqual(microphoneReadiness(false, "missing", {
    microphonePermission: "denied",
    microphoneDevices: [],
  }), {
    ready: true,
    selectedMissing: false,
    selectedName: "Microphone off",
    recovery: "none",
  });
  assert.equal(microphoneReadiness(true, null, {
    microphonePermission: "not_determined",
    microphoneDevices: [],
  }).recovery, "request_access");
  assert.equal(microphoneReadiness(true, null, {
    microphonePermission: "denied",
    microphoneDevices: [],
  }).recovery, "open_settings");
  assert.equal(microphoneReadiness(true, null, {
    microphonePermission: "authorized",
    microphoneDevices: [],
  }).recovery, "connect_device");
  assert.deepEqual(microphoneReadiness(true, "missing", authorized), {
    ready: false,
    selectedMissing: true,
    selectedName: "Disconnected source",
    recovery: "choose_device",
  });
});

test("authorized default and exact microphone choices are ready and honestly named", () => {
  assert.deepEqual(microphoneReadiness(true, null, authorized), {
    ready: true,
    selectedMissing: false,
    selectedName: "MacBook Microphone",
    recovery: "none",
  });
  assert.deepEqual(microphoneReadiness(true, "usb", authorized), {
    ready: true,
    selectedMissing: false,
    selectedName: "USB Microphone",
    recovery: "none",
  });
});
