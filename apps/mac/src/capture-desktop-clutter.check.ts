import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("capture HUD exposes one legacy-safe desktop cleanup choice", async () => {
  const [model, view, nativeSettings] = await Promise.all([
    readFile(new URL("capture-hud.ts", import.meta.url), "utf8"),
    readFile(new URL("CaptureHud.tsx", import.meta.url), "utf8"),
    readFile(new URL("src-tauri/src/capture_hud.rs", root), "utf8"),
  ]);

  assert.match(model, /hideDesktopIcons: boolean/);
  assert.match(model, /hideDesktopIcons: false/);
  assert.match(model, /candidate\.hideDesktopIcons === true/);
  assert.match(view, /aria-label="Hide desktop icons while capturing"/);
  assert.match(view, /checked=\{settings\.hideDesktopIcons\}/);
  assert.match(view, /hideDesktopIcons: event\.target\.checked/);
  assert.match(nativeSettings, /#\[serde\(default\)\][\s\S]*?hide_desktop_icons: bool/);
});

test("every screenshot path preflights storage and restores one shared desktop lease", async () => {
  const [capture, recording, library] = await Promise.all([
    readFile(new URL("src-tauri/src/capture.rs", root), "utf8"),
    readFile(new URL("src-tauri/src/recording.rs", root), "utf8"),
    readFile(new URL("src-tauri/src/lib.rs", root), "utf8"),
  ]);

  assert.match(recording, /pub\(crate\) struct DesktopClutterLease/);
  assert.match(recording, /impl<R: Runtime> Drop for DesktopClutterLease<R>/);
  assert.match(recording, /pub\(crate\) fn desktop_clutter_warning/);
  assert.match(capture, /fn prepare_capture_output/);
  assert.match(
    capture,
    /async fn capture_screen[\s\S]*?prepare_capture_output[\s\S]*?DesktopClutterLease::begin[\s\S]*?spawn_blocking[\s\S]*?desktop_clutter\.restore\(\)/,
  );
  assert.ok((capture.match(/DesktopClutterLease::begin/g) ?? []).length >= 4);
  assert.ok((capture.match(/desktop_clutter\.restore\(\)/g) ?? []).length >= 4);
  assert.match(library, /recording::desktop_clutter_warning\(app\)/);
});
