import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the quick access overlay can turn a capture into an always-on-top pin", async () => {
  const [overlay, entrypoint, native, pinNative, config, pinCapability] = await Promise.all([
    readFile(new URL("./CaptureOverlay.tsx", import.meta.url), "utf8"),
    readFile(new URL("./main.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/pin.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/capabilities/pinned-capture.json", import.meta.url), "utf8"),
  ]);

  assert.match(overlay, /aria-label="Pin capture"/);
  assert.match(overlay, /invoke<[^>]+>\("pin_overlay_capture"/);
  assert.match(entrypoint, /surface === "pin"/);
  assert.match(native, /pin_overlay_capture/);
  assert.match(
    native,
    /window\.label\(\) == pin::PIN_LABEL \{(?:(?!return;)[\s\S])*?api\.prevent_close\(\)/,
    "closing the reusable pin window must hide it instead of destroying it",
  );
  assert.match(config, /"alwaysOnTop": true/);
  assert.match(config, /"visibleOnAllWorkspaces": true/);
  assert.match(pinCapability, /"windows": \["pinned-capture"\]/);
  assert.match(pinCapability, /"core:event:default"/);
  assert.match(
    pinNative,
    /pin_overlay_capture[\s\S]*?window\s*\.show\(\)[\s\S]*?app\.emit_to\(PIN_LABEL, "pin-capture"/,
    "the native window must be visible before publishing to a potentially suspended webview",
  );
});

test("settings separate general, shortcuts, account, and advanced decisions", async () => {
  const app = await readFile(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(app, /role="tablist"/);
  assert.match(app, />General<\/button>/);
  assert.match(app, />Shortcuts<\/button>/);
  assert.match(app, />Account<\/button>/);
  assert.match(app, />Advanced<\/button>/);
  assert.match(app, /aria-selected=/);
  assert.match(app, /role="tabpanel"/);
  assert.match(app, /aria-controls=/);
  assert.match(app, /aria-labelledby=/);
  assert.match(app, /ArrowRight/);
  assert.match(app, /ArrowLeft/);
  assert.match(app, /Enable Window &amp; Full Screen/);
});

test("the parity features are discoverable from the tray menu, not a settings table", async () => {
  const [app, native, history] = await Promise.all([
    readFile(new URL("./App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/history.rs", import.meta.url), "utf8"),
  ]);

  // The old "Where to find them" table documented features the menu now shows
  // directly. Documentation is only redundant while the menu items really exist.
  assert.doesNotMatch(app, /quick-access-heading/);
  assert.doesNotMatch(app, /Where to find them/);

  assert.match(native, /"Capture (?:Area|Region) in 5 Seconds"/);
  assert.match(native, /"Recent Captures"/);
  assert.match(native, /"Settings…"/);
  assert.match(history, /RECENT_CAPTURE_LIMIT: usize = 8;/);
});

test("advanced settings surface read-only capture diagnostics", async () => {
  const app = await readFile(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(app, /invoke<Diagnostics>\("get_diagnostics"\)/);
  assert.match(app, /latency_title/);
  assert.match(app, /latency_status/);
  assert.match(app, /latency_statistics/);
  assert.match(app, /queue_label/);
  assert.match(app, /queue_retryable/);
  assert.match(
    app,
    /Could not load diagnostics: \$\{String\(error\)\}/,
    "a failing diagnostics command must surface its error instead of blanking the panel",
  );
});

test("only one Capso process can own the global shortcuts", async () => {
  const [manifest, native] = await Promise.all([
    readFile(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
  ]);

  assert.match(manifest, /tauri-plugin-single-instance/);
  const singleInstance = native.indexOf("tauri_plugin_single_instance::init");
  const globalShortcut = native.indexOf("tauri_plugin_global_shortcut::Builder");
  assert.ok(singleInstance >= 0, "single-instance plugin must be registered");
  assert.ok(
    singleInstance < globalShortcut,
    "single-instance guard must initialize before the global shortcut plugin",
  );
});

test("clicking a shortcut recorder gives its key handler focus", async () => {
  const app = await readFile(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(
    app,
    /onClick=\{\(event\) => \{\s*event\.currentTarget\.focus\(\);\s*setRecording\(action\)/,
  );
  assert.match(app, /Saved\. Switch to another app to use your shortcuts\./);
});

test("the five-second area timer has a visible cancellable surface", async () => {
  const [entrypoint, timer, native, config] = await Promise.all([
    readFile(new URL("./main.tsx", import.meta.url), "utf8"),
    readFile(new URL("./CaptureTimer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  ]);

  assert.match(entrypoint, /surface === "timer"/);
  assert.match(timer, /aria-label="Cancel area capture timer"/);
  assert.match(timer, /event\.key === "Escape"/);
  assert.match(timer, /invoke\("cancel_region_self_timer"\)/);
  assert.match(native, /cancel_region_self_timer/);
  assert.match(native, /region-timer-changed/);
  assert.match(config, /"label": "capture-timer"/);
  assert.match(config, /"alwaysOnTop": true/);
});

test("the pinned capture can be dismissed with Escape", async () => {
  const [pin, native, clipboard] = await Promise.all([
    readFile(new URL("./PinCapture.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/pin.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/clipboard.rs", import.meta.url), "utf8"),
  ]);

  assert.match(pin, /event\.key === "Escape"/);
  assert.match(pin, /void closeCapture\(\)/);
  assert.match(
    pin,
    /onError=\{\(\) => \{[\s\S]*?pin_image_ready/,
    "an image decode failure must still reveal the pin's fallback and Close control",
  );
  assert.match(pin, /listen<PinCopyEvent>\("pin-copy-finished"/);
  assert.match(native, /"pin-copy-finished"/);
  assert.match(clipboard, /schedule_recopy_current_capture_to_general_pasteboard/);
});
