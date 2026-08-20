import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("recording desktop cleanup is exact, compensated, and restart recoverable", async () => {
  const [recording, library, cargo] = await Promise.all([
    readFile(new URL("../src-tauri/src/recording.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8"),
  ]);

  assert.match(
    cargo,
    /objc2-core-foundation = \{[^\n]*features = \["std", "CFNumber", "CFPreferences", "CFPropertyList", "CFString"\]/,
  );
  assert.match(recording, /struct MacDesktopClutterSystem/);
  assert.match(recording, /CFPreferencesCopyValue/);
  assert.match(recording, /CFPreferencesSetValue/);
  assert.match(recording, /CFPreferencesSynchronize/);
  assert.match(
    recording,
    /fn start_recording\([\s\S]*?recording_paths\(&app, &id\)[\s\S]*?if request\.hide_desktop_icons \{[\s\S]*?begin_recording_desktop_clutter\(&app\)/,
  );
  assert.match(
    recording,
    /fn monitor_recording\([\s\S]*?restore_recording_desktop_clutter\(&app\)[\s\S]*?begin_finalizing\(session_id\)/,
  );
  assert.match(recording, /note_desktop_clutter_warning/);
  assert.match(
    recording,
    /spawn\(\)[\s\S]*?map_err\([\s\S]*?restore_recording_desktop_clutter\(&app\)/,
  );
  assert.match(library, /recording::recover_desktop_clutter\(app\.handle\(\)\)/);
});

test("recording controls expose desktop cleanup without hiding its active state", async () => {
  const [studio, styles] = await Promise.all([
    readFile(new URL("./RecordingStudio.tsx", import.meta.url), "utf8"),
    readFile(new URL("./App.css", import.meta.url), "utf8"),
  ]);

  assert.match(studio, /hideDesktopIcons: boolean/);
  assert.match(studio, /hideDesktopIcons: false/);
  assert.match(studio, /desktopClutterWarning: string \| null/);
  assert.match(studio, /aria-label="Hide desktop icons while recording"/);
  assert.match(studio, /checked=\{request\.hideDesktopIcons\}/);
  assert.match(studio, /hideDesktopIcons: event\.target\.checked/);
  assert.match(studio, /<strong>Desktop icons<\/strong>/);
  assert.match(studio, /<small>Restore when done<\/small>/);
  assert.match(
    studio,
    /snapshot\.hideDesktopIcons \? "Desktop icons hidden" : "Desktop unchanged"/,
  );
  assert.match(
    studio,
    /error \?\? snapshot\.desktopClutterWarning \?\? snapshot\.message \?\? snapshot\.historyWarning/,
  );
  assert.match(
    styles,
    /\.recording-studio__options \{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/,
  );
});
