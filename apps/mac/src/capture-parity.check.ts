import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("native pin windows remain bounded independently of the compact Quick Access UI", async () => {
  const [entrypoint, native, pinNative, config, pinCapability] = await Promise.all([
    readFile(new URL("./main.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/pin.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/capabilities/pinned-capture.json", import.meta.url), "utf8"),
  ]);

  assert.match(entrypoint, /surface === "pin"/);
  assert.match(native, /pin_overlay_capture/);
  assert.match(
    native,
    /pin::is_pin_window_label\(window\.label\(\)\)[\s\S]*?api\.prevent_close\(\)/,
    "closing one dynamic pin must be intercepted without affecting another pin",
  );
  assert.doesNotMatch(config, /"label": "pinned-capture"/);
  assert.match(pinCapability, /"pinned-capture-\*"/);
  assert.match(pinCapability, /"core:event:default"/);
  assert.match(pinNative, /const MAX_ACTIVE_PINS: usize = 8/);
  assert.match(pinNative, /WebviewWindowBuilder::new/);
  assert.match(pinNative, /\.always_on_top\(true\)/);
  assert.match(pinNative, /\.visible_on_all_workspaces\(true\)/);
  assert.match(
    pinNative,
    /pin_overlay_capture[\s\S]*?create_pin_window[\s\S]*?emit_to\(&window_label, "pin-capture"/,
    "each capture must receive an independently addressed pin window",
  );
});

test("multiple pins expose bounded resize, opacity, lock and durable lifecycle controls", async () => {
  const [pin, pinNative, native] = await Promise.all([
    readFile(new URL("./PinCapture.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/pin.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
  ]);

  assert.match(pin, /parameters\.get\("pinId"\)/);
  assert.match(pin, /aria-label="Decrease pinned capture size"/);
  assert.match(pin, /aria-label="Increase pinned capture size"/);
  assert.match(pin, /aria-label="Pinned capture opacity"/);
  assert.match(pin, /aria-label=\{capture\.locked \? "Unlock pinned capture" : "Lock pinned capture"\}/);
  assert.match(pin, /"resize_pin_capture"/);
  assert.match(pin, /"set_pin_opacity"/);
  assert.match(pin, /"set_pin_locked"/);
  assert.match(pinNative, /const PIN_STORE_FILE: &str = "pinned-captures.json"/);
  assert.match(pinNative, /save_pin_store/);
  assert.match(pinNative, /restore_pinned_captures/);
  assert.match(native, /pin::record_window_geometry/);
});

test("native recording has an explicit bounded setup, stop and MP4 finalization journey", async () => {
  const [studio, hud, entrypoint, recordingNative, native, config, capability] = await Promise.all([
    readFile(new URL("./RecordingStudio.tsx", import.meta.url), "utf8"),
    readFile(new URL("./CaptureHud.tsx", import.meta.url), "utf8"),
    readFile(new URL("./main.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/recording.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/capabilities/recording-studio.json", import.meta.url), "utf8"),
  ]);

  assert.match(entrypoint, /surface === "recording"/);
  assert.match(config, /"label": "recording-studio"/);
  assert.match(capability, /"windows": \["recording-studio"\]/);
  assert.match(studio, /role="radiogroup" aria-label="Recording area"/);
  assert.match(studio, /\["window", "Window",/);
  assert.match(studio, /aria-label="Include microphone"/);
  assert.match(studio, /aria-label="Show pointer clicks"/);
  assert.match(studio, /aria-label="Include pointer in full-screen recording"/);
  assert.match(studio, /Full-screen only/);
  assert.match(studio, /aria-label="Recording quality"/);
  assert.match(studio, /Start recording/);
  assert.match(studio, /Stop and save/);
  assert.match(studio, /Show in Finder/);
  assert.match(hud, /"open_recording_studio"/);
  assert.match(recordingNative, /const MAX_RECORDING_SECONDS: u32 = 7_200/);
  assert.match(recordingNative, /"\/usr\/sbin\/screencapture"/);
  assert.match(recordingNative, /request\.show_cursor[\s\S]*?arguments\.push\("-C"\.into\(\)\)/);
  assert.match(recordingNative, /validate_recording_request/);
  assert.match(recordingNative, /"\/usr\/bin\/avconvert"/);
  assert.match(recordingNative, /PresetHighestQuality/);
  assert.match(recordingNative, /Preset1920x1080/);
  assert.match(recordingNative, /Preset1280x720/);
  assert.match(recordingNative, /validate_mp4/);
  assert.match(recordingNative, /scan_recording_history/);
  assert.match(studio, /Recent recordings/);
  assert.match(studio, /<video/);
  assert.match(studio, /aria-label="Trim start"/);
  assert.match(studio, /aria-label="Trim end"/);
  assert.match(studio, /aria-label="Edited copy quality"/);
  assert.match(studio, /Save trimmed copy/);
  assert.match(studio, /"trim_recording"/);
  assert.match(recordingNative, /pub\(crate\) async fn trim_recording/);
  assert.match(recordingNative, /"--start"/);
  assert.match(recordingNative, /"--duration"/);
  assert.match(native, /recording::RecordingRuntime::default\(\)/);
  assert.match(native, /recording::start_recording/);
  assert.match(native, /recording::stop_recording/);
});

test("recording editor exports bounded native GIF copies without an ffmpeg dependency", async () => {
  const [studio, recordingNative, native, cargo] = await Promise.all([
    readFile(new URL("./RecordingStudio.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/recording.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8"),
  ]);

  assert.match(studio, /aria-label="Editor output format"/);
  assert.match(studio, /aria-label="GIF width"/);
  assert.match(studio, /aria-label="GIF frame rate"/);
  assert.match(studio, /aria-label="Loop GIF forever"/);
  assert.match(studio, /Export GIF copy/);
  assert.match(studio, /"export_recording_gif"/);
  assert.match(recordingNative, /const MAX_GIF_DURATION_MS: u64 = 30_000/);
  assert.match(recordingNative, /const MAX_GIF_FRAMES: usize = 450/);
  assert.match(recordingNative, /fn gif_frame_plan/);
  assert.match(recordingNative, /fn validate_gif/);
  assert.match(recordingNative, /pub\(crate\) async fn export_recording_gif/);
  assert.match(recordingNative, /AVAssetImageGenerator/);
  assert.match(recordingNative, /Repeat::Infinite/);
  assert.match(native, /recording::export_recording_gif/);
  assert.match(cargo, /objc2-av-foundation/);
  assert.match(cargo, /^gif = /m);
  assert.doesNotMatch(cargo, /^ffmpeg\s*=/m);
});

test("native local-original actions accept only the exact current capture", async () => {
  const [native, history] = await Promise.all([
    readFile(new URL("../src-tauri/src/overlay.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/history.rs", import.meta.url), "utf8"),
  ]);

  assert.match(native, /fn validated_current_local_capture/);
  assert.match(native, /current_capture_path\(runtime, path, presentation_id\)\?/);
  assert.match(native, /resolve_recent_capture_for_app\(app, id\)\?/);
  assert.match(native, /reveal_item_in_dir\(&capture\.path\)/);
  assert.match(native, /open_path\(&capture\.path, None::<&str>\)/);
  assert.match(history, /decode_png\(&capture\.path\)/);
});

test("History opens every safe capture in Annotate and keeps double-click distinct from Quick Access", async () => {
  const [historyView, annotation, project] = await Promise.all([
    readFile(new URL("./HistoryView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/annotation.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/annotation_project.rs", import.meta.url), "utf8"),
  ]);

  assert.match(historyView, /onDoubleClick=/);
  assert.match(historyView, /historyCardClickAction\(event\.detail\)/);
  assert.match(historyView, /capture\.annotationRevision \? "Edit annotation" : "Annotate"/);
  assert.match(historyView, /open_history_annotation_editor/);
  assert.match(annotation, /load_optional_for_capture/);
  assert.match(project, /without its editable project/);
  assert.match(project, /symlink_metadata/);
});

test("Quick Access Save writes directly to the Settings folder without a save dialog", async () => {
  const [overlay, filename, native, app, cargo, settings] = await Promise.all([
    readFile(new URL("./CaptureOverlay.tsx", import.meta.url), "utf8"),
    readFile(new URL("./overlay-drag.ts", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/overlay.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8"),
    readFile(new URL("./App.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(overlay, /aria-label="Save capture as PNG or JPEG"/);
  assert.match(overlay, /"get_save_as_preferences"/);
  assert.doesNotMatch(overlay, /plugin-dialog/);
  assert.match(overlay, /filename: suggestedCaptureFilename/);
  assert.match(overlay, /format: "png" \| "jpeg"/);
  assert.match(overlay, /transparency uses white/);
  assert.match(filename, /\{ name: "PNG image", extensions: \["png"\] \}/);
  assert.match(filename, /\{ name: "JPEG image", extensions: \["jpg", "jpeg"\] \}/);
  assert.match(filename, /filenameTemplate/);
  assert.match(filename, /"\{date\}"/);
  assert.match(filename, /"\{time\}"/);
  assert.match(settings, /aria-label="Capture save folder"/);
  assert.match(settings, /"choose_capture_save_directory"/);
  assert.match(settings, /aria-label="Default save format"/);
  assert.match(settings, /aria-label="Save As filename template"/);
  assert.match(native, /enum CaptureExportFormat/);
  assert.match(native, /struct OverlaySaveAsPreferences/);
  assert.match(native, /default_save_directory/);
  assert.match(native, /preferences\.directory/);
  assert.match(native, /JpegEncoder::new_with_quality/);
  assert.match(native, /255_u16 \* inverse/);
  assert.match(native, /validate_exported_image/);
  assert.match(native, /fs::symlink_metadata\(destination\)/);
  assert.match(native, /create_new\(true\)/);
  assert.match(app, /get_save_as_preferences/);
  assert.match(cargo, /features = \["jpeg", "png"\]/);
});

test("Annotate exports the current clean canvas through the same safe PNG and JPEG contract", async () => {
  const [editor, annotation, overlay, native] = await Promise.all([
    readFile(new URL("./AnnotationEditor.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/annotation.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/overlay.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
  ]);

  assert.match(editor, /aria-label="Export annotated image"/);
  assert.match(editor, /"export_annotation_copy"/);
  assert.match(editor, /get_save_as_preferences/);
  assert.match(editor, /repaint\(false\)[\s\S]*?toDataURL\("image\/png"\)[\s\S]*?repaint\(true\)/);
  assert.match(annotation, /pub\(crate\) async fn export_annotation_copy/);
  assert.match(annotation, /validate_annotation_drag_pixels/);
  assert.match(annotation, /overlay::export_png_bytes/);
  assert.match(overlay, /pub\(crate\) fn export_png_bytes/);
  assert.match(native, /annotation::export_annotation_copy/);
});

test("Annotate copies a clean current-session PNG without saving or closing the project", async () => {
  const [editor, annotation, clipboard, native] = await Promise.all([
    readFile(new URL("./AnnotationEditor.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/annotation.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/clipboard.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
  ]);

  assert.match(editor, /aria-label="Copy annotated image"/);
  assert.match(editor, /"copy_annotation_image"/);
  assert.match(editor, /project unchanged/);
  assert.match(annotation, /pub\(crate\) async fn copy_annotation_image/);
  assert.match(annotation, /validate_annotation_drag_pixels/);
  assert.match(annotation, /recopy_current_png_bytes_to_general_pasteboard/);
  assert.match(clipboard, /pub\(crate\) async fn recopy_current_png_bytes_to_general_pasteboard/);
  assert.match(clipboard, /ticket_for_current/);
  assert.match(native, /annotation::copy_annotation_image/);
});

test("Quick Access remembers corner, size, and autoclose per connected display", async () => {
  const [settings, overlay, timing, native] = await Promise.all([
    readFile(new URL("./App.tsx", import.meta.url), "utf8"),
    readFile(new URL("./CaptureOverlay.tsx", import.meta.url), "utf8"),
    readFile(new URL("./overlay-timing.ts", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/overlay.rs", import.meta.url), "utf8"),
  ]);

  assert.match(settings, /Quick Access behavior/);
  assert.match(settings, /aria-label="Quick Access display"/);
  assert.match(settings, /aria-label="Quick Access position"/);
  assert.match(settings, /aria-label="Quick Access size"/);
  assert.match(settings, /aria-label="Quick Access autoclose"/);
  assert.doesNotMatch(settings, /<option value="never">/);
  assert.match(settings, /invoke<OverlaySettingsSnapshot>\("get_overlay_settings"\)/);
  assert.match(settings, /invoke<OverlaySettingsSnapshot>\("update_overlay_settings"/);
  assert.match(settings, /Save or discard changes before switching displays/);
  assert.match(settings, />Discard changes</);
  assert.match(overlay, /autoDismissMs: number \| null/);
  assert.match(overlay, /createOverlayAutoDismissTimer/);
  assert.doesNotMatch(overlay, /!hovered/);
  assert.match(timing, /if \(durationMs === null\) return null/);
  assert.match(native, /OVERLAY_SETTINGS_FILE/);
  assert.match(native, /profiles: BTreeMap<String, OverlayPreferences>/);
  assert.match(native, /fn update_overlay_settings/);
  assert.match(
    native,
    /OverlayAutoDismiss::EightSeconds\s*\|\s*OverlayAutoDismiss::FifteenSeconds\s*\|\s*OverlayAutoDismiss::Never/,
  );
  assert.match(native, /Self::Never\s*=>\s*Some\(10_000\)/);
  assert.match(native, /window\.size_overlay\(width, height\)[\s\S]*?window\.position_overlay\(x, y\)/);
});

test("settings cards keep their intrinsic height so compact windows scroll instead of clipping", async () => {
  const css = await readFile(new URL("./App.css", import.meta.url), "utf8");

  assert.match(
    css,
    /\.settings-panel\s*\{[\s\S]*?grid-auto-rows:\s*max-content;/,
  );
  assert.match(css, /body\s*\{[^}]*min-width:\s*min\(520px,\s*100vw\)/s);
});

test("every Quick Access size is a full-bleed preview with no bottom row", async () => {
  const [overlay, css] = await Promise.all([
    readFile(new URL("./CaptureOverlay.tsx", import.meta.url), "utf8"),
    readFile(new URL("./App.css", import.meta.url), "utf8"),
  ]);

  assert.match(
    css,
    /\.capture-overlay__preview\s*\{[\s\S]*?inset:\s*0;/,
  );
  assert.doesNotMatch(overlay, /capture-overlay__footer/);
  assert.doesNotMatch(css, /\.capture-overlay__footer\s*\{/);
});

test("Quick Access reveals exactly Copy and Save over the image", async () => {
  const [settings, overlay, css, config, cargo] = await Promise.all([
    readFile(new URL("./App.tsx", import.meta.url), "utf8"),
    readFile(new URL("./CaptureOverlay.tsx", import.meta.url), "utf8"),
    readFile(new URL("./App.css", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8"),
  ]);

  assert.match(overlay, /className="capture-overlay__hover-actions"/);
  assert.match(overlay, /aria-label="Copy capture"/);
  assert.match(overlay, /aria-label="Save capture as PNG or JPEG"/);
  assert.doesNotMatch(overlay, /aria-label="Pin capture"/);
  assert.doesNotMatch(overlay, /aria-label="Annotate capture"/);
  assert.doesNotMatch(overlay, /aria-label="Hide Quick Access temporarily"/);
  assert.doesNotMatch(overlay, /aria-label="Capture file information"/);
  assert.doesNotMatch(settings, /className="quick-access-settings__actions"/);
  assert.match(css, /\.capture-overlay__hover-actions\s*\{[\s\S]*?opacity:\s*0;/);
  assert.match(css, /\.capture-overlay:hover\s+\.capture-overlay__hover-actions/);
  const parsedConfig = JSON.parse(config) as {
    app: { windows: Array<Record<string, unknown>> };
  };
  const overlayWindow = parsedConfig.app.windows.find(
    (window) => window.label === "capture-overlay",
  );
  assert.equal(overlayWindow?.transparent, true);
  assert.equal(overlayWindow?.backgroundThrottling, "disabled");
  assert.match(config, /"macOSPrivateApi":\s*true/);
  assert.match(cargo, /tauri\s*=\s*\{[^}]*"macos-private-api"/);
});

test("Quick Access paints exact pixels after native show and trackpad-swipes right to dismiss", async () => {
  const [overlay, swipe, css] = await Promise.all([
    readFile(new URL("./CaptureOverlay.tsx", import.meta.url), "utf8"),
    readFile(new URL("./overlay-swipe.ts", import.meta.url), "utf8"),
    readFile(new URL("./App.css", import.meta.url), "utf8"),
  ]);

  assert.match(
    overlay,
    /const commitPrepared = useCallback\([\s\S]*?setPreparedPresentation\(presentation\)[\s\S]*?const requestNativeShow = useCallback\([\s\S]*?invoke<boolean>\("overlay_image_ready"/,
  );
  assert.doesNotMatch(
    overlay,
    /setPreparedPresentation\(presentation\)[\s\S]{0,800}?setRevealedPresentation\(presentation\)/,
  );
  assert.match(
    overlay,
    /await image\.decode\(\)[\s\S]*?setImageReady\(true\)[\s\S]*?commitPrepared\(\)/,
  );
  assert.match(
    overlay,
    /revealResult === "shown"[\s\S]*?setNativeShownPresentation\(presentation\)/,
  );
  assert.match(
    overlay,
    /requestNativeOverlayRevealWithRetry\([\s\S]*?invoke<boolean>\("overlay_image_ready"[\s\S]*?window\.setTimeout[\s\S]*?3[\s\S]*?\)/,
  );
  assert.match(
    overlay,
    /revealResult === "not_shown"[\s\S]*?revealRequestedPresentation\.current = null/,
  );
  assert.match(
    overlay,
    /revealResult === "failed"[\s\S]*?invoke<boolean>\("overlay_dismiss",\s*\{[\s\S]*?path,[\s\S]*?presentationId,[\s\S]*?reason: "close"[\s\S]*?\}\)[\s\S]*?setCapture/,
  );
  assert.match(
    overlay,
    /revealResult === "failed"[\s\S]*?let dismissed = false[\s\S]*?dismissed = await invoke<boolean>\("overlay_dismiss"[\s\S]*?if \(!dismissed\)[\s\S]*?return;[\s\S]*?actionCoordinator\.current\?\.dismiss/,
  );
  assert.doesNotMatch(
    overlay,
    /invoke<boolean>\("overlay_dismiss"[\s\S]{0,700}?\.finally\(\(\) =>[\s\S]{0,500}?setCapture/,
  );
  assert.match(
    overlay,
    /const dismiss = useCallback\([\s\S]*?\{ path, presentationId, surfaceGeneration \} = capture[\s\S]*?invoke<boolean>\("overlay_dismiss",\s*\{\s*path,\s*presentationId,\s*surfaceGeneration,\s*reason,?\s*\}\)/,
  );
  assert.match(
    overlay,
    /listen<OverlayRestored>\("overlay-restored"[\s\S]*?setTemporarilyHidden\(false\)/,
  );
  assert.match(
    overlay,
    /listen<OverlayDismissed>[\s\S]*?"capture-overlay-dismissed"[\s\S]*?scheduleDomHiddenAck[\s\S]*?setCapture\(null\)/,
  );
  assert.match(
    overlay,
    /scheduleOverlayDomHiddenAcknowledgement\([\s\S]*?surfaceGeneration[\s\S]*?overlay_dom_hidden_painted/,
  );
  assert.match(
    overlay,
    /invoke<OverlayRendererSnapshot>\(\s*"overlay_renderer_ready"/,
  );
  assert.match(overlay, /reduceOverlayLifecycle\(lifecycleState\(\),/);
  assert.match(
    overlay,
    /if \(lifecycle\.decision === "resync"\)[\s\S]*?resyncRenderer\(lifecycle\.state\.surfaceGeneration\)/,
  );
  assert.doesNotMatch(
    overlay,
    /Promise\.all\([\s\S]*?get_overlay_surface_state[\s\S]*?get_overlay_capture/,
  );
  assert.match(
    overlay,
    /shouldRequestOverlayReveal\([\s\S]*?imageReady[\s\S]*?temporarilyHidden[\s\S]*?commitPrepared\(\)/,
  );
  assert.match(
    overlay,
    /const isPrepared =[\s\S]*?imageReady[\s\S]*?!imageFailed[\s\S]*?preparedPresentation === capture\.presentation/,
  );
  assert.match(
    overlay,
    /const isSurfaceWarm =[\s\S]*?warmedSurfaceGeneration === capture\.surfaceGeneration/,
  );
  assert.match(
    overlay,
    /const isRevealed =[\s\S]*?isSurfaceWarm[\s\S]*?!temporarilyHidden/,
  );
  assert.match(
    overlay,
    /nativeShownPresentation !== capture\.presentation[\s\S]*?scheduleOverlayPaintAcknowledgement\([\s\S]*?flushSync\(\(\) => setRevealedPresentation\(presentation\)\)/,
  );
  assert.match(
    overlay,
    /invoke<boolean>\("overlay_presentation_painted",\s*\{\s*path,\s*presentationId,\s*surfaceGeneration,\s*reducedMotion,?\s*\}\)/,
  );
  assert.match(
    overlay,
    /const shouldRunAutoDismiss =[\s\S]*?!nativeRuntime[\s\S]*?isRevealed/,
  );
  assert.match(overlay, /data-revealed=/);
  assert.match(overlay, /data-native-runtime=\{nativeRuntime\}/);
  assert.match(overlay, /aria-hidden=\{!isRevealed\}/);
  assert.match(overlay, /inert=\{!isRevealed\}/);
  assert.match(css, /\.capture-overlay\s*\{[\s\S]*?visibility:\s*hidden;/);
  assert.match(
    css,
    /\.capture-overlay\[data-revealed="true"\]\s*\{[\s\S]*?visibility:\s*visible;/,
  );
  assert.match(
    overlay,
    /const timerPresentation = capture\?\.presentation[\s\S]*?actionCoordinator\.current\?\.generation\(\) !== timerPresentation[\s\S]*?dismissRef\.current\("timeout"\)/,
  );
  assert.match(overlay, /addEventListener\("wheel"/);
  assert.match(overlay, /new OverlaySwipeGesture/);
  assert.match(overlay, /invoke<boolean>\("overlay_set_auto_dismiss_paused"/);
  assert.match(
    overlay,
    /invoke<boolean>\("overlay_set_auto_dismiss_paused",\s*\{\s*path,\s*presentationId,\s*surfaceGeneration,\s*paused,?\s*\}\)/,
  );
  assert.match(
    overlay,
    /invoke<OverlayDragStarted>\("overlay_start_drag",\s*\{\s*path,\s*presentationId,\s*surfaceGeneration,/,
  );
  assert.match(
    overlay,
    /listen<OverlayDragEnded>\("overlay-drag-ended"[\s\S]*?active\.surfaceGeneration !== event\.payload\.surfaceGeneration[\s\S]*?captureRef\.current\?\.surfaceGeneration !== event\.payload\.surfaceGeneration/,
  );
  assert.match(
    overlay,
    /invoke<boolean>\("overlay_image_failed",\s*\{[\s\S]*?surfaceGeneration: failed\.surfaceGeneration/,
  );
  assert.match(
    overlay,
    /handleImageFailure = useCallback[\s\S]*?invoke<boolean>\("overlay_image_failed"[\s\S]*?if \(!accepted\) return;/,
  );
  assert.match(
    overlay,
    /presentation=\$\{capture\.presentationId\}&surface=\$\{capture\.surfaceGeneration\}/,
  );
  assert.match(
    overlay,
    /key=\{`\$\{capture\.path\}:\$\{capture\.presentationId\}:\$\{capture\.surfaceGeneration\}`\}/,
  );
  assert.match(
    overlay,
    /onLoad=[\s\S]*?isExactOverlayRendererIdentity\([\s\S]*?surfaceGenerationRef\.current[\s\S]*?loadedCapture/,
  );
  assert.match(overlay, /const \[toolbarHovered, setToolbarHovered\] = useState\(false\)/);
  assert.match(
    overlay,
    /rendererOwnsAutoDismissPause\([\s\S]*?busyAction,[\s\S]*?toolbarHovered[\s\S]*?\)/,
  );
  assert.match(
    overlay,
    /const setToolbarAutoDismissPaused = useCallback\([\s\S]*?setToolbarHovered\(paused\)[\s\S]*?setRendererAutoDismissPaused\(capture, shouldPause\)/,
  );
  assert.match(
    overlay,
    /onPointerEnter=\{\(\) => setToolbarAutoDismissPaused\(true\)\}/,
  );
  assert.match(
    overlay,
    /onPointerLeave=\{\(\) => setToolbarAutoDismissPaused\(false\)\}/,
  );
  assert.match(
    overlay,
    /async function copyCapture\(\)[\s\S]*?await setRendererAutoDismissPaused\(capture, true\)[\s\S]*?invoke<ClipboardStatus>\("overlay_copy_capture"/,
  );
  assert.match(
    overlay,
    /async function saveCapture\(\)[\s\S]*?await setRendererAutoDismissPaused\(capture, true\)[\s\S]*?invoke<OverlaySaveResult>\("overlay_save_capture"/,
  );
  assert.match(
    overlay,
    /onPointerDown=\{\(event\) => \{[\s\S]*?setRendererAutoDismissPaused\(capture, true\)/,
  );
  assert.match(
    overlay,
    /rawEvent\.preventDefault\(\);[\s\S]{0,600}?clearTimeout\(swipeSettleTimer\.current\)[\s\S]{0,600}?result\.kind === "tracking"/,
  );
  assert.match(overlay, /prefers-reduced-motion/);
  assert.match(swipe, /directionInvertedFromDevice/);
  assert.match(swipe, /Math\.min\(96,\s*width \* 0\.25\)/);
  assert.match(css, /\.capture-overlay\[data-revealed="true"\]/);
  assert.doesNotMatch(
    css,
    /\.capture-overlay\[data-native-runtime="true"\]\[data-swipe-phase="idle"\]\s*\{\s*transition:\s*none;/,
  );
  assert.match(css, /\.capture-overlay\[data-swipe-phase="exiting"\]/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]{0,300}?\.capture-overlay\s*\{[\s\S]*?transition:\s*none;/,
  );
});

test("Quick Access restore cannot strand an active decoded-image reveal lease", async () => {
  const overlay = await readFile(new URL("./CaptureOverlay.tsx", import.meta.url), "utf8");
  const restoreStart = overlay.indexOf(
    'unlistenRestore = await listen<OverlayRestored>("overlay-restored"',
  );
  const restoreEnd = overlay.indexOf("unlistenDismissed =", restoreStart);
  const restoreHandler = restoreStart >= 0 && restoreEnd > restoreStart
    ? overlay.slice(restoreStart, restoreEnd)
    : "";
  const revealCurrency = overlay.match(
    /const isCurrent = \(\) =>[\s\S]*?const revealResult =/,
  )?.[0] ?? "";

  assert.notEqual(restoreHandler, "");
  assert.match(
    restoreHandler,
    /activateCapture\(current\.path\)[\s\S]*?surfaceGeneration: event\.payload\.surfaceGeneration[\s\S]*?scheduleDomHiddenAck/,
  );
  assert.match(
    restoreHandler,
    /scheduleDomHiddenAck[\s\S]*?setTemporarilyHidden\(false\)/,
  );
  assert.match(
    revealCurrency,
    /surfaceGenerationRef\.current === surfaceGeneration/,
  );
  assert.doesNotMatch(restoreHandler, /setNativeShownPresentation\(presentation\)/);
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
  assert.match(app, /Screen Recording is required for every screenshot mode/);
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

test("local history is a dedicated bounded surface that restores through Quick Access", async () => {
  const [view, entrypoint, native, history, config, capability] = await Promise.all([
    readFile(new URL("./HistoryView.tsx", import.meta.url), "utf8"),
    readFile(new URL("./main.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/history.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/capabilities/default.json", import.meta.url), "utf8"),
  ]);

  assert.match(entrypoint, /surface === "history"/);
  assert.match(view, /invoke<HistorySnapshot>\("get_local_history"\)/);
  assert.match(view, /invoke<AnnotationProjectSyncStatus>\("get_annotation_project_sync_status"\)/);
  assert.match(view, /"annotation-project-sync-changed"/);
  assert.match(view, /"retry_annotation_project_sync"/);
  assert.match(view, /"keep_local_annotation_project"/);
  assert.match(view, /Keep this Mac version/);
  assert.match(view, /invoke\("restore_history_capture", \{ id: capture\.id \}\)/);
  assert.match(view, /Open in Quick Access/);
  assert.doesNotMatch(view, /copy, save or pin it there/i);
  assert.match(native, /"Capture History…"/);
  assert.match(native, /get_local_history/);
  assert.match(native, /restore_history_capture/);
  assert.match(native, /get_annotation_project_sync_status/);
  assert.match(native, /retry_annotation_project_sync/);
  assert.match(native, /keep_local_annotation_project/);
  assert.match(history, /HISTORY_CAPTURE_LIMIT: usize = 500;/);
  assert.match(config, /"label": "history"/);
  assert.match(capability, /"windows": \["main", "history"\]/);
});

test("Capture History exposes honest native capture-type provenance and filtering", async () => {
  const [historyView, historyModel, historyNative, queue, capture] = await Promise.all([
    readFile(new URL("./HistoryView.tsx", import.meta.url), "utf8"),
    readFile(new URL("./history-view.ts", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/history.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/queue.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/capture.rs", import.meta.url), "utf8"),
  ]);

  assert.match(historyView, /aria-label="Capture type"/);
  assert.match(historyView, /historyCaptureKindLabel\(capture\.source\)/);
  assert.match(historyModel, /type HistoryCaptureSource/);
  assert.match(historyModel, /source\?: HistoryCaptureSource/);
  assert.match(historyNative, /source: Option<QueueSource>/);
  assert.match(queue, /Created/);
  assert.match(capture, /QueueSource::Created/);
});

test("history extracts bounded text on-device and copies only the exact OCR session", async () => {
  const [view, native, ocr] = await Promise.all([
    readFile(new URL("./HistoryView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/ocr.rs", import.meta.url), "utf8"),
  ]);

  assert.match(view, /Extract text/);
  assert.match(view, /invoke<[^>]+>\("recognize_history_capture_text"/);
  assert.match(view, /OCR image…/);
  assert.match(view, /invoke<SelectedOcrResult \| null>\("recognize_selected_png_text"/);
  assert.match(view, /OCR area…/);
  assert.match(view, /invoke<SelectedOcrResult \| null>\("recognize_screen_selection_text"/);
  assert.match(view, /invoke\("copy_recognized_text"/);
  assert.match(view, /On-device Apple Vision/);
  assert.match(view, /aria-label="Recognized text"/);
  assert.match(native, /recognize_history_capture_text/);
  assert.match(native, /recognize_selected_png_text/);
  assert.match(native, /recognize_screen_selection_text/);
  assert.match(native, /copy_recognized_text/);
  assert.match(ocr, /VNRecognizeTextRequest/);
  assert.match(ocr, /setAutomaticallyDetectsLanguage\(true\)/);
  assert.match(ocr, /setUsesLanguageCorrection\(false\)/);
  assert.match(ocr, /MAX_OCR_TEXT_BYTES/);
  assert.match(ocr, /resolve_recent_capture_for_app/);
  assert.match(ocr, /blocking_pick_file/);
  assert.match(ocr, /validate_selected_png/);
  assert.match(ocr, /capture::acquire_capture_lease/);
  assert.match(ocr, /EphemeralOcrSelection/);
  assert.match(ocr, /cleanup_ephemeral_selections/);
  assert.match(view, /The selected PNG stays in its original location/);
  assert.match(view, /selected screen pixels are removed immediately after recognition/i);
});

test("OCR web links are bounded, scheme-safe and copied only by stored session index", async () => {
  const [view, native, ocr] = await Promise.all([
    readFile(new URL("./HistoryView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/ocr.rs", import.meta.url), "utf8"),
  ]);

  assert.match(view, /Detected web links/);
  assert.match(view, /aria-label=\{`Copy link \$\{index \+ 1\}/);
  assert.match(view, /invoke\("copy_recognized_link"/);
  assert.match(native, /copy_recognized_link/);
  assert.match(ocr, /const MAX_OCR_LINKS: usize = 32/);
  assert.match(ocr, /fn recognized_links/);
  assert.match(ocr, /link_for_copy/);
  assert.match(ocr, /\["http", "https"\]/);
});

test("history combines ordered local captures into one new durable capture", async () => {
  const [view, model, native, history, capture] = await Promise.all([
    readFile(new URL("./HistoryView.tsx", import.meta.url), "utf8"),
    readFile(new URL("./history-view.ts", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/history.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/capture.rs", import.meta.url), "utf8"),
  ]);

  assert.match(view, /Combine images/);
  assert.match(view, /aria-label="Combined image layout"/);
  assert.match(view, /draggable=\{busy === null\}/);
  assert.match(view, /dataTransfer\.setData\("text\/plain", capture\.id\)/);
  assert.match(view, /dataTransfer\.getData\("text\/plain"\)/);
  assert.match(view, /reorderCombineSelection/);
  assert.match(view, /invoke<[^>]+>\("combine_history_captures"/);
  assert.match(view, /Horizontal/);
  assert.match(view, /Vertical/);
  assert.match(view, /Grid/);
  assert.match(model, /MAX_COMBINE_SELECTION = 8/);
  assert.match(native, /fn combine_history_captures/);
  assert.match(native, /capture::acquire_capture_lease\(\)/);
  assert.match(native, /history::combine_captures/);
  assert.match(native, /finish_launched_capture\(&app, &result, None\)/);
  assert.match(history, /copy_from\(&image, x, y\)/);
  assert.match(history, /ImageReader::/);
  assert.match(history, /Limits::default\(\)/);
  assert.match(history, /create_new\(true\)/);
  assert.match(capture, /publish_created_capture/);
});

test("history frames one local capture for social delivery without mutating its source", async () => {
  const [view, model, native, history, capture] = await Promise.all([
    readFile(new URL("./HistoryView.tsx", import.meta.url), "utf8"),
    readFile(new URL("./history-view.ts", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/history.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/capture.rs", import.meta.url), "utf8"),
  ]);

  assert.match(view, /Frame for social/);
  assert.match(view, /aria-label="Social frame background"/);
  assert.match(view, /aria-label="Social frame padding"/);
  assert.match(view, /aria-label="Social frame alignment"/);
  assert.match(view, /aria-label="Social frame aspect ratio"/);
  assert.match(view, /Auto-balance/);
  assert.match(view, /customBackground/);
  assert.match(view, /invoke<[^>]+>\("frame_history_capture"/);
  assert.match(model, /selectFrameCapture/);
  assert.match(native, /fn frame_history_capture/);
  assert.match(native, /capture::acquire_capture_lease\(\)/);
  assert.match(native, /history::frame_capture/);
  assert.match(native, /finish_launched_capture\(&app, &result, None\)/);
  assert.match(history, /blend_opaque_background/);
  assert.match(history, /create_new\(true\)/);
  assert.match(capture, /publish_created_capture/);
});

test("history removal is durable, reversible and never deletes canonical or editable pixels", async () => {
  const [view, model, native, history] = await Promise.all([
    readFile(new URL("./HistoryView.tsx", import.meta.url), "utf8"),
    readFile(new URL("./history-view.ts", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/history.rs", import.meta.url), "utf8"),
  ]);

  assert.match(view, /Remove from History/);
  assert.match(view, /Clear History/);
  assert.match(view, /Files stay safe on this Mac/);
  assert.match(view, /invoke<string\[\]>\("remove_history_captures"/);
  assert.match(view, /invoke<string\[\]>\("clear_capture_history"/);
  assert.match(view, /invoke\("restore_history_captures"/);
  assert.match(view, />Undo</);
  assert.match(model, /removed: number/);
  assert.match(native, /fn remove_history_captures/);
  assert.match(native, /fn clear_capture_history/);
  assert.match(native, /fn restore_history_captures/);
  assert.match(history, /HISTORY_REMOVAL_SUFFIX/);
  assert.match(history, /scan_history_excluding/);
  assert.match(history, /scan_recent_menu_entries_excluding/);
  assert.match(history, /remove_captures_from_history/);
  assert.match(history, /restore_captures_to_history/);
  assert.doesNotMatch(
    history,
    /remove_captures_from_history[\s\S]{0,4000}fs::remove_file\([^)]*captures_directory/,
    "removing from History must not delete the queue-owned canonical PNG",
  );
});

test("account conflict actions open the local decision surface", async () => {
  const [app, native] = await Promise.all([
    readFile(new URL("./App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
  ]);

  assert.match(app, /syncState\.action === "history"/);
  assert.match(app, /invoke\("open_capture_history"\)/);
  assert.match(app, /Review in History/);
  assert.match(native, /fn open_capture_history/);
  assert.match(native, /history::show_history_window/);
});

test("editable annotation revisions reopen from protected originals without weakening flattened PNG delivery", async () => {
  const [view, editor, native, project, projectSync, captureMirror, history, entrypoint] = await Promise.all([
    readFile(new URL("./HistoryView.tsx", import.meta.url), "utf8"),
    readFile(new URL("./AnnotationEditor.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/annotation.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/annotation_project.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/annotation_sync.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/capture_mirror.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/history.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
  ]);

  assert.match(view, /invoke\("open_history_annotation_editor", \{ id: capture\.id \}\)/);
  assert.match(view, /Editable revision \$\{capture\.annotationRevision\}/);
  assert.match(editor, /capture\.marks\.length === 0/);
  assert.match(editor, /convertFileSrc\(capture\.sourcePath\)/);
  assert.match(editor, /documentRevision: capture\.documentRevision/);
  assert.match(editor, /marks,/);
  assert.match(native, /begin_existing/);
  assert.match(native, /load_optional_for_capture/);
  assert.match(native, /persist_for_capture/);
  assert.match(native, /if capture\.editing_existing/);
  assert.match(project, /PROJECT_SCHEMA_VERSION: u32 = 1/);
  assert.match(project, /original_sha256/);
  assert.match(project, /flattened_sha256/);
  assert.match(project, /This editable annotation changed after the editor opened/);
  assert.match(projectSync, /struct DurableAnnotationSyncQueue/);
  assert.match(projectSync, /fn stage_for_app/);
  assert.match(projectSync, /fn initialize_for_app/);
  assert.match(projectSync, /fn drain_for_app/);
  assert.match(projectSync, /fn reconcile_remote_for_app/);
  assert.match(projectSync, /list_remote_annotation_heads/);
  assert.match(projectSync, /download_remote_annotation_revision/);
  assert.match(projectSync, /annotation_project::install_remote_revision/);
  assert.match(projectSync, /is_editing_capture/);
  assert.match(projectSync, /drop\(runtime\)/);
  assert.match(captureMirror, /fn reconcile_remote_captures/);
  assert.match(captureMirror, /MAX_DOWNLOADS_PER_PASS: usize = 8/);
  assert.match(captureMirror, /stage_remote_capture/);
  assert.match(captureMirror, /download_remote_capture/);
  assert.match(captureMirror, /complete_remote_capture/);
  assert.match(native, /annotation_sync::stage_for_app\(&app, sync_candidate\)/);
  assert.match(native, /if capture\.editing_existing \{[\s\S]*?DrainWake::AnnotationSaved/);
  assert.match(history, /annotation_revision/);
  assert.match(entrypoint, /Mutex::new\(annotation_sync::AnnotationSyncRuntime::default\(\)\)/);
  assert.match(entrypoint, /annotation_sync::initialize_for_app\(app\.handle\(\)\)/);
  assert.match(entrypoint, /\.uploaded_capture_ids\(\)/);
  assert.match(entrypoint, /annotation_sync::drain_for_app\(/);
  assert.match(entrypoint, /annotation_sync::reconcile_remote_for_app\(/);
  const captureMirrorIndex = entrypoint.indexOf("capture_mirror::reconcile_remote_captures(");
  const annotationMirrorIndex = entrypoint.indexOf("annotation_sync::reconcile_remote_for_app(");
  assert.ok(captureMirrorIndex >= 0, "background sync must run screenshot discovery");
  assert.ok(
    captureMirrorIndex < annotationMirrorIndex,
    "base screenshots must be installed before their editable annotation revisions",
  );
  assert.match(
    entrypoint,
    /capture_mirror_report\.downloaded > 0[\s\S]{0,240}emit\("history-changed"/,
    "an open History window must refresh when remote screenshots become local",
  );
  assert.match(entrypoint, /annotation::open_history_annotation_editor/);
});

test("advanced settings surface read-only capture diagnostics", async () => {
  const [app, native, automation] = await Promise.all([
    readFile(new URL("./App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/automation.rs", import.meta.url), "utf8"),
  ]);

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
  assert.match(app, /capso:\/\/capture\/area/);
  assert.match(app, /capso:\/\/capture\/window/);
  assert.match(app, /capso:\/\/capture\/fullscreen/);
  assert.match(app, /capso:\/\/open\/history/);
  assert.match(app, /capso:\/\/open\/recording/);
  assert.match(app, /\?delay=3/);
  assert.match(app, /Only capture URLs accept the optional delay/);
  assert.match(native, /receive_deep_link/);
  assert.match(native, /automation::DeepLinkRoute::AuthCallback/);
  assert.match(native, /automation::DeepLinkRoute::Automation/);
  assert.match(native, /delay_seconds == 0/);
  assert.match(native, /launch_capture_timer\(app\.clone\(\), capture_action, delay_seconds, false\)/);
  assert.match(automation, /value\.starts_with\("capso:\/\/auth\/callback\?"\)/);
  assert.match(automation, /"3" => Some\(3\)/);
  assert.match(automation, /"5" => Some\(5\)/);
  assert.match(automation, /"10" => Some\(10\)/);
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
  const [app, config, onboarding, firstRun] = await Promise.all([
    readFile(new URL("./App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
    readFile(new URL("./onboarding.ts", import.meta.url), "utf8"),
    readFile(new URL("./FirstRun.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(
    app,
    /onClick=\{\(event\) => \{\s*event\.currentTarget\.focus\(\);\s*void startShortcutRecording\(action, event\.currentTarget\)/,
  );
  assert.match(app, /set_shortcut_recording[\s\S]*?active: true,[\s\S]*?generation: null/);
  assert.doesNotMatch(app, /aria-pressed=/);
  assert.match(app, /Saved\. Switch to another app to use your shortcuts\./);
  assert.match(app, /region: "Command\+Shift\+Digit4"/);
  assert.match(app, /macOS may still own ⌘⇧4/);
  assert.match(onboarding, /⌘⇧4 by default/);
  assert.doesNotMatch(firstRun, /Use Area only/);
  assert.match(firstRun, /screenRecordingPresentation/);
  assert.match(config, /"label": "main"[\s\S]*?"titleBarStyle": "Visible"/);
  assert.match(config, /"label": "main"[\s\S]*?"hiddenTitle": false/);
});

test("capture permission requires effective authorization and explains build identity", async () => {
  const [app, firstRun, native, system] = await Promise.all([
    readFile(new URL("./App.tsx", import.meta.url), "utf8"),
    readFile(new URL("./FirstRun.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/system.rs", import.meta.url), "utf8"),
  ]);

  assert.match(
    firstRun,
    /const status = await invoke<SystemStatus>\("request_screen_recording_permission"\)/,
  );
  assert.match(
    firstRun,
    /permissionView\.primaryAction === "settings"[\s\S]*?open_screen_recording_settings[\s\S]*?\} else \{[\s\S]*?request_screen_recording_permission/,
  );
  assert.match(
    firstRun,
    /const label =[\s\S]*?permissionView\.primaryAction === "settings"[\s\S]*?"Open System Settings"[\s\S]*?permissionView\.primaryLabel/,
  );
  const requestBranch = firstRun.slice(
    firstRun.indexOf(
      'const status = await invoke<SystemStatus>("request_screen_recording_permission")',
    ),
    firstRun.indexOf('} else if (current.id === "hotkey")'),
  );
  assert.doesNotMatch(requestBranch, /open_screen_recording_settings/);
  assert.match(requestBranch, /setNote\(screenRecordingPresentation\(status\)\.notice\)/);
  assert.doesNotMatch(firstRun, /screenRecordingSkipped|areaOnlyCapture|Area-only/);
  assert.doesNotMatch(native, /set_area_only_capture_preference/);
  assert.match(native, /fn restart_capso\(app: AppHandle\)/);
  assert.match(system, /enum ScreenRecordingIdentity/);
  assert.match(system, /Signature=adhoc/);
  assert.doesNotMatch(app, /Area capture still works|Use Area only|handleAreaOnlyCapture/);
  assert.match(app, /screenRecordingPresentation/);
});

test("capture delays have a visible cancellable surface for every mode", async () => {
  const [entrypoint, timer, native, config] = await Promise.all([
    readFile(new URL("./main.tsx", import.meta.url), "utf8"),
    readFile(new URL("./CaptureTimer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  ]);

  assert.match(entrypoint, /surface === "timer"/);
  assert.match(timer, /Cancel \$\{MODE_LABEL\[timer\.mode\]\.toLowerCase\(\)\} capture timer/);
  assert.match(timer, /event\.key === "Escape"/);
  assert.match(timer, /invoke\("cancel_capture_timer"\)/);
  assert.match(native, /cancel_capture_timer/);
  assert.match(native, /capture-timer-changed/);
  assert.match(native, /capture_timer_is_running\(&app\)/);
  assert.match(config, /"label": "capture-timer"/);
  assert.match(config, /"alwaysOnTop": true/);
});

test("Area capture always uses the live native drag and commits on mouse-up", async () => {
  const [native, capture] = await Promise.all([
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/capture.rs", import.meta.url), "utf8"),
  ]);
  const launch = native.slice(
    native.indexOf("fn launch_capture("),
    native.indexOf("fn launch_previous_area_capture("),
  );
  const captureScreen = capture.slice(
    capture.indexOf("pub(crate) async fn capture_screen("),
    capture.indexOf("pub(crate) async fn capture_previous_area("),
  );

  assert.match(launch, /capture::capture_screen\(app\.clone\(\), action\.mode\(\)\)\.await/);
  assert.doesNotMatch(launch, /screen_recording_granted\(\)[\s\S]*capture_selected_area/);
  assert.doesNotMatch(launch, /capture::capture_selected_area/);
  assert.match(launch, /capture_hud::record_system_previous_area\(&record_app\)/);
  assert.match(capture, /CaptureMode::Region => &\["-i", "-s", "-x", "-t", "png"\]/);
  assert.match(captureScreen, /run_capture\(&app_data, mode, &capture_id, &SystemCaptureRunner\)/);
  assert.match(captureScreen, /publish_stored_capture\(&app, mode, stored\)\.await/);
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

test("the annotation surface reports geometry, erasable freehand, spotlight and counter marks", async () => {
  const [editor, history, shared, native, nativeProject] = await Promise.all([
    readFile(new URL("./AnnotationEditor.tsx", import.meta.url), "utf8"),
    readFile(new URL("./annotation-history.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../packages/shared/src/annotate.ts", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/annotation.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/annotation_project.rs", import.meta.url), "utf8"),
  ]);

  assert.match(editor, /PRIMARY_TOOLS: Tool\[\] = \["arrow", "line", "box", "ellipse", "text", "pencil"\]/);
  assert.match(editor, /MORE_TOOLS: Tool\[\] = \["counter", "highlighter", "eraser", "spotlight", "blur", "blur-effect", "crop"\]/);
  assert.match(editor, /aria-haspopup="menu"/);
  assert.match(editor, /role="menuitemradio"/);
  assert.match(editor, /aria-label="Layer order"/);
  assert.match(editor, /aria-label=\{styleKind === "text" \? "Text size" : "Counter size"\}/);
  assert.match(editor, /aria-label="Arrow style"/);
  assert.match(editor, /Pick and save custom annotation color/);
  assert.match(editor, /saveAnnotationCustomColor/);
  assert.match(editor, /customColors/);
  assert.match(editor, /arrowStyle, x1: at\.x, y1: at\.y/);
  assert.match(editor, /aria-label="Text style"/);
  assert.match(editor, /aria-label="Edit selected text"/);
  assert.match(editor, /function beginTextEdit/);
  assert.match(editor, /onDoubleClick=\{editTextAt\}/);
  assert.match(editor, /textStyle,/);
  assert.match(editor, /tool === "box" \|\| tool === "ellipse"/);
  assert.match(editor, /aria-label="Shape style"/);
  assert.match(editor, /aria-label="Stroke width"/);
  assert.match(editor, /strokeWeight,/);
  assert.match(editor, /nextCounterValue\(marks, counterStart\)/);
  assert.match(editor, /aria-label="Counter style"/);
  assert.match(editor, /aria-label="Counter starting number"/);
  assert.match(editor, /changeCounterStyle/);
  assert.match(editor, /mark\.kind === "counter"\s*\? \[\]/);
  assert.match(editor, /MORE_TOOLS: Tool\[\] = \[[^\]]*"eraser"/);
  assert.match(editor, /eraseFreehandMarks/);
  assert.match(editor, /type: "erase"/);
  assert.match(editor, /detectSmartHighlightBand/);
  assert.match(editor, /event\.metaKey/);
  assert.match(editor, /smartWidth/);
  assert.match(editor, /aria-label="Highlighter opacity"/);
  assert.match(editor, /changeHighlighterOpacity/);
  assert.match(editor, /aria-label="Drag annotated image"/);
  assert.match(editor, /startAnnotationDrag/);
  assert.match(editor, /invoke<AnnotationDragStarted>\("start_annotation_drag"/);
  assert.match(editor, /listen<AnnotationDragEnded>\("annotation-drag-ended"/);
  assert.match(editor, /suggestedCaptureFilename\(\)/);
  assert.match(editor, /highlighterOpacity/);
  assert.match(shared, /highlighterOpacityFor/);
  assert.match(editor, /marks\.some\(\(mark\) => mark\.kind === "spotlight"\)/);
  assert.match(editor, /aria-label="Blur mode"/);
  assert.match(editor, /aria-label="Blur intensity"/);
  assert.match(editor, /changeBlurStrength/);
  assert.match(editor, /Secure blur destroys detail/);
  assert.match(editor, /Smooth blur is visual only/);
  assert.match(editor, /aria-label="Spotlight strength"/);
  assert.match(editor, /aria-label="Spotlight shape"/);
  assert.match(editor, /spotlightShape/);
  assert.match(editor, /aria-label="Resize output resolution"/);
  assert.match(editor, /aria-label="Output width"/);
  assert.match(editor, /aria-label="Output height"/);
  assert.match(editor, /imageScaleForOutputDimension/);
  assert.match(editor, /isValidImageScale/);
  assert.match(editor, /imageScale,/);
  assert.match(editor, /aria-label="Canvas zoom"/);
  assert.match(editor, /aria-label="Zoom out canvas"/);
  assert.match(editor, /aria-label="Zoom in canvas"/);
  assert.match(editor, /aria-label="Reset canvas zoom to fit"/);
  assert.match(editor, /fitCanvasSize/);
  assert.match(editor, /zoomedCanvasSize/);
  assert.match(editor, /modifier && \(key === "\+" \|\| key === "="\)/);
  assert.match(editor, /hitResizeHandle/);
  assert.match(editor, /resizeMark/);
  assert.match(editor, /axisLockedDelta\(pointerDelta\.x, pointerDelta\.y\)/);
  assert.match(editor, /translate\(moving\.before, delta\.x, delta\.y\)/);
  assert.match(editor, /rectFromSquareDrag\(anchor\.x, anchor\.y, at\.x, at\.y\)/);
  assert.match(editor, /event\.altKey && mark\.kind !== "spotlight"/);
  assert.match(editor, /moving\.duplicate/);
  assert.match(editor, /dispatchEdit\(\{ type: "add", mark: moving\.after \}\)/);
  assert.match(editor, /Duplicate cancelled\. The original mark is unchanged\./);
  assert.match(editor, /modifier && key === "d" && selected !== null/);
  assert.match(editor, /duplicateSelectedMark\(marks, selected, counterStart\)/);
  assert.match(editor, /Duplicate selected · ⌘Z removes only the copy/);
  assert.match(editor, /modifier && key === "c" && selected !== null/);
  assert.match(editor, /modifier && key === "v"/);
  assert.match(editor, /objectClipboardRef/);
  assert.match(editor, /input, textarea, \[contenteditable/);
  assert.match(editor, /Pasted object · ⌘Z removes only the pasted copy/);
  assert.match(history, /export function copySelectedMark/);
  assert.match(history, /export function pasteCopiedMark/);
  assert.match(history, /mark\.kind === "spotlight" && marks\.some/);
  assert.match(editor, /appendFreehandPoint/);
  assert.match(editor, /cropFromDrag/);
  assert.match(editor, /dispatchEdit\(\{ type: "crop", crop: committedCrop \}\)/);
  assert.match(editor, /crop: editState\.crop/);
  assert.match(editor, /function updateSelectedMark/);
  assert.match(editor, /Use \$\{style\} shape/);
  assert.match(shared, /m\.kind === "ellipse"/);
  assert.match(shared, /ctx\.ellipse\(/);
  assert.match(shared, /ctx\.globalAlpha = 0\.18/);
  assert.match(shared, /strokeFor\(imageWidth, weight\)/);
  assert.match(shared, /arrowCurveControl/);
  assert.match(shared, /ctx\.quadraticCurveTo\(control\.x, control\.y/);
  assert.match(shared, /textLayout/);
  assert.match(shared, /"rounded-boxed"/);
  assert.match(shared, /m\.kind === "counter"/);
  assert.match(shared, /ctx\.arc\(/);
  assert.match(shared, /DEFAULT_COUNTER_STYLE/);
  assert.match(shared, /m\.kind === "spotlight"/);
  assert.match(shared, /spotlightOpacityFor\(m\.strength\)/);
  assert.match(shared, /m\.spotlightShape \?\? DEFAULT_SPOTLIGHT_SHAPE/);
  assert.match(shared, /ctx\.fill\("evenodd"\)/);
  assert.match(shared, /resizeHandles/);
  assert.match(shared, /export function axisLockedDelta/);
  assert.match(shared, /export function rectFromSquareDrag/);
  assert.match(shared, /export function imageScaleOutputSize/);
  assert.match(shared, /ctx\.quadraticCurveTo/);
  assert.match(shared, /ctx\.globalAlpha = highlighterOpacityFor\(m\.highlighterOpacity\)/);
  assert.match(shared, /blurStrengthParameters/);
  assert.match(shared, /m\.blurStrength \?\? DEFAULT_BLUR_STRENGTH/);
  assert.match(native, /Line,/);
  assert.match(native, /Ellipse,/);
  assert.match(native, /Counter,/);
  assert.match(native, /Spotlight,/);
  assert.match(native, /Resize,/);
  assert.match(nativeProject, /spotlight_shape: SpotlightShape/);
  assert.match(nativeProject, /highlighter_opacity: Option<HighlighterOpacity>/);
  assert.match(nativeProject, /image_scale: f64/);
  assert.match(native, /Pencil,/);
  assert.match(native, /Highlighter,/);
  assert.match(native, /pub\(crate\) async fn start_annotation_drag/);
  assert.match(native, /validate_annotation_drag_pixels/);
  assert.match(native, /drag::DragMode::Copy/);
  assert.match(native, /Crop,/);
});

test("crop offers exact reversible aspect presets and a temporary square snap", async () => {
  const [editor, shared] = await Promise.all([
    readFile(new URL("./AnnotationEditor.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../../packages/shared/src/annotate.ts", import.meta.url), "utf8"),
  ]);

  assert.match(editor, /aria-label="Crop aspect ratio"/);
  assert.match(editor, /Free/);
  assert.match(editor, />1:1</);
  assert.match(editor, />4:3</);
  assert.match(editor, />5:4</);
  assert.match(editor, />16:9</);
  assert.match(editor, />9:16</);
  assert.match(editor, /event\.shiftKey \? "square"/);
  assert.match(editor, /cropFromDragWithAspect/);
  assert.match(editor, /Shift snaps to 1:1/);
  assert.match(editor, /dispatchEdit\(\{ type: "crop", crop: committedCrop \}\)/);
  assert.match(shared, /export function cropFromDragWithAspect/);
  assert.match(shared, /maximumUnits/);
});

test("rotate and flip are one non-destructive source-space orientation contract", async () => {
  const [editor, history, shared, native, project] = await Promise.all([
    readFile(new URL("./AnnotationEditor.tsx", import.meta.url), "utf8"),
    readFile(new URL("./annotation-history.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../packages/shared/src/annotate.ts", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/annotation.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/annotation_project.rs", import.meta.url), "utf8"),
  ]);

  assert.match(editor, /aria-label="Image transform"/);
  assert.match(editor, /imagePointFromOutput/);
  assert.match(editor, /imagePointToOutput/);
  assert.match(editor, /imageDeltaFromOutput/);
  assert.match(editor, /renderCanvasRef/);
  assert.match(editor, /imageTransformMatrix/);
  assert.match(editor, /imageTransform,/);
  assert.match(history, /kind: "transform"/);
  assert.match(shared, /export function updateImageTransform/);
  assert.match(shared, /export function imageTransformMatrix/);
  assert.match(native, /Transform,/);
  assert.match(native, /persist_flattened_png_with_crop_and_transform/);
  assert.match(project, /persist_for_capture_with_transform/);
  assert.match(project, /skip_serializing_if = "is_default_image_transform"/);
});

test("annotation undo and redo cover additions, deletions, reorders, and committed moves", async () => {
  const [editor, history] = await Promise.all([
    readFile(new URL("./AnnotationEditor.tsx", import.meta.url), "utf8"),
    readFile(new URL("./annotation-history.ts", import.meta.url), "utf8"),
  ]);

  assert.match(editor, /aria-label="Undo last annotation"/);
  assert.match(editor, /aria-label="Redo last annotation"/);
  assert.match(editor, /dispatchEdit\(\{ type: "delete", index: selected \}\)/);
  assert.match(editor, /type: "commit_move"/);
  assert.match(editor, /type: "update"/);
  assert.match(editor, /event\.shiftKey \? 10 : 1/);
  assert.match(editor, /tabIndex=\{0\}/);
  assert.match(editor, /event\.ctrlKey && key === "y"/);
  assert.match(history, /type: "add"/);
  assert.match(history, /type: "delete"/);
  assert.match(history, /kind: "reorder"/);
  assert.match(history, /kind: "update"/);
  assert.match(history, /action\.type === "undo"/);
  assert.match(history, /state\.redo\.at\(-1\)/);
});
