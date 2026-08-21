import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const capture = readFileSync(
  new URL("../src-tauri/src/capture.rs", import.meta.url),
  "utf8",
);
const lib = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const ocr = readFileSync(new URL("../src-tauri/src/ocr.rs", import.meta.url), "utf8");
const overlay = readFileSync(
  new URL("../src-tauri/src/overlay.rs", import.meta.url),
  "utf8",
);
const captureOverlay = readFileSync(
  new URL("./CaptureOverlay.tsx", import.meta.url),
  "utf8",
);

test("a no-output picker result is rechecked for revoked Screen Recording access", () => {
  const captureScreen = capture.slice(
    capture.indexOf("pub(crate) async fn capture_screen"),
    capture.indexOf("pub(crate) async fn capture_previous_area"),
  );
  assert.match(capture, /fn resolve_cancelled_capture_permission/);
  assert.match(
    captureScreen,
    /resolve_cancelled_capture_permission\([\s\S]*?stored_result\?[\s\S]*?screen_recording_granted\(\)/,
  );
  assert.match(capture, /code: "screen_recording_required"/);
  assert.match(capture, /Area, Window, and Full Screen/);
  assert.match(
    lib,
    /finish_launched_capture[\s\S]*?screen_recording_required[\s\S]*?show_permission_guidance/,
  );
});

test("live OCR area selection uses the same permission preflight and post-picker recovery", () => {
  assert.match(
    ocr,
    /recognize_screen_selection_text[\s\S]*?screen_recording_granted\(\)[\s\S]*?Screen Recording is required/,
  );
  assert.match(
    ocr,
    /if !output\.exists\(\)[\s\S]*?screen_recording_granted\(\)[\s\S]*?return Ok\(None\)/,
  );
});

test("shortcut recording suspends global capture before listening for the same keys", () => {
  assert.match(app, /async function startShortcutRecording/);
  assert.match(
    app,
    /startShortcutRecording[\s\S]*?invoke<ShortcutRecordingResult>\([\s\S]*?"set_shortcut_recording",[\s\S]*?active: true,[\s\S]*?generation: null[\s\S]*?setRecording\(action\)/,
  );
  assert.match(
    app,
    /stopShortcutRecording[\s\S]*?restoreShortcutRecording\(message\)/,
  );
  assert.match(
    app,
    /restoreShortcutRecording[\s\S]*?invoke<ShortcutRecordingResult>\([\s\S]*?"set_shortcut_recording",[\s\S]*?active: false,[\s\S]*?generation/,
  );
  assert.doesNotMatch(app, /aria-pressed=/);
  assert.match(lib, /fn set_shortcut_recording\(/);
  assert.match(lib, /tauri::generate_handler!\[[\s\S]*?set_shortcut_recording/);
});

test("shortcut recording remains focusable while suspension starts and only clears after resume", () => {
  assert.match(app, /shortcutRecordingTarget/);
  assert.match(app, /shortcutRecordingGeneration/);
  assert.match(
    app,
    /startShortcutRecording\([\s\S]*?invoke<ShortcutRecordingResult>\([\s\S]*?"set_shortcut_recording",[\s\S]*?active: true,[\s\S]*?generation: null[\s\S]*?\.focus\(\)[\s\S]*?setRecording\(action\)/,
  );
  assert.doesNotMatch(
    app,
    /className="shortcut-recorder"[\s\S]{0,300}disabled=\{isSaving \|\| shortcutRecordingBusy\}/,
  );
  assert.match(
    app,
    /restoreShortcutRecording[\s\S]*?invoke<ShortcutRecordingResult>\([\s\S]*?"set_shortcut_recording",[\s\S]*?active: false,[\s\S]*?generation[\s\S]*?shortcutRecordingGeneration\.current = null/,
  );
  assert.doesNotMatch(
    app,
    /shortcutRecordingGeneration\.current = null;[\s\S]{0,300}invoke<ShortcutRecordingResult>\([\s\S]*?"set_shortcut_recording",[\s\S]*?active: false/,
  );
  assert.match(lib, /generation: Option<u64>/);
  assert.match(lib, /runtime\.recording_session_matches\(generation\)/);
});

test("hiding or unfocusing the settings window restores suspended shortcuts", () => {
  assert.match(lib, /fn restore_shortcuts_after_recording\(/);
  assert.match(
    lib,
    /WindowEvent::CloseRequested[\s\S]*?window\.label\(\) == "main"[\s\S]*?restore_shortcuts_after_recording/,
  );
  assert.match(
    lib,
    /WindowEvent::Focused\(false\)[\s\S]*?window\.label\(\) == "main"[\s\S]*?restore_shortcuts_after_recording/,
  );
});

test("global capture shortcuts remain active while Settings is focused", () => {
  const handlerStart = lib.indexOf("tauri_plugin_global_shortcut::Builder::new()");
  const handler = lib.slice(
    handlerStart,
    lib.indexOf(".build(),", handlerStart),
  );
  assert.doesNotMatch(handler, /settings_are_focused|is_focused\(\)/);
  assert.match(
    handler,
    /should_ignore_global_shortcut\(annotation::is_active\(app\)\)/,
  );
});

test("a consecutive capture hides the previous Quick Access preview until completion", () => {
  const captureScreen = capture.slice(
    capture.indexOf("pub(crate) async fn capture_screen"),
    capture.indexOf("pub(crate) async fn capture_previous_area"),
  );
  assert.match(
    captureScreen,
    /CaptureOverlayLease::begin\(app\.clone\(\)\)[\s\S]*?spawn_blocking/,
  );
  assert.match(overlay, /pub\(crate\) struct CaptureOverlayLease/);
  assert.match(
    overlay,
    /impl Drop for CaptureOverlayLease[\s\S]*?restore_temporarily_hidden_overlay/,
  );
  assert.match(overlay, /emit_to\([\s\S]*?"overlay-hidden"/);
  assert.match(
    captureOverlay,
    /listen<OverlayRestored>\("overlay-hidden"[\s\S]*?setTemporarilyHidden\(true\)/,
  );
  assert.match(
    captureOverlay,
    /listen<OverlayRestored>\("overlay-restored"[\s\S]*?remainingMs\(\) === 0[\s\S]*?reset\(\)/,
  );
  const hideHelper = overlay.slice(
    overlay.indexOf("fn hide_current_overlay_for_capture"),
    overlay.indexOf("#[tauri::command]", overlay.indexOf("fn hide_current_overlay_for_capture")),
  );
  assert.match(
    hideHelper,
    /let Some\(capture\)[\s\S]*?get_webview_window\(OVERLAY_LABEL\)/,
  );
});

test("permission guidance never claims Area works without Screen Recording", () => {
  assert.doesNotMatch(app, /Area works now/);
  assert.doesNotMatch(app, /Enable Window (?:&amp;|and) Full Screen/);
  assert.match(app, /Screen Recording is required for every screenshot mode/);
});
