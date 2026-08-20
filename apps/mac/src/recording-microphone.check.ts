import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("recording microphone capability is packaged, native, and permission-aware", async () => {
  const [plist, manifest, native, library] = await Promise.all([
    readFile(new URL("src-tauri/Info.plist", root), "utf8"),
    readFile(new URL("src-tauri/Cargo.toml", root), "utf8"),
    readFile(new URL("src-tauri/src/recording.rs", root), "utf8"),
    readFile(new URL("src-tauri/src/lib.rs", root), "utf8"),
  ]);

  assert.match(plist, /<key>NSMicrophoneUsageDescription<\/key>/);
  assert.match(manifest, /"AVCaptureDevice"/);
  assert.match(manifest, /"AVMediaFormat"/);
  assert.match(native, /pub\(crate\) struct RecordingCapabilities/);
  assert.match(native, /pub\(crate\) enum MicrophonePermission/);
  assert.match(native, /AVCaptureDevice::authorizationStatusForMediaType/);
  assert.match(native, /AVCaptureDevice::devicesWithMediaType/);
  assert.match(native, /request_recording_microphone_access/);
  assert.match(native, /open_recording_microphone_settings/);
  assert.match(library, /recording::get_recording_capabilities/);
  assert.match(library, /recording::request_recording_microphone_access/);
});

test("Recording Studio selects an exact microphone and exposes recovery states", async () => {
  const studio = await readFile(new URL("RecordingStudio.tsx", import.meta.url), "utf8");

  assert.match(studio, /microphoneDeviceId: string \| null/);
  assert.match(studio, /invoke<RecordingCapabilities>\("get_recording_capabilities"\)/);
  assert.match(studio, /aria-label="Microphone source"/);
  assert.match(studio, /System default/);
  assert.match(studio, /request_recording_microphone_access/);
  assert.match(studio, /open_recording_microphone_settings/);
  assert.match(studio, /Microphone access is required/);
  assert.match(studio, /selected microphone is no longer connected/i);
});
