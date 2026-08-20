import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("active recording time is visible beside the menu bar icon and clears on every exit", async () => {
  const [recording, library] = await Promise.all([
    readFile(new URL("../src-tauri/src/recording.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
  ]);

  assert.match(recording, /pub\(crate\) fn recording_tray_title/);
  assert.match(recording, /last_tray_refresh_second/);
  assert.match(recording, /crate::refresh_recording_tray_title\(&app\)/);
  assert.match(
    library,
    /fn refresh_recording_tray_title\([\s\S]*?tray\.set_title\(recording::recording_tray_title\(app\)\)/,
  );
  assert.match(
    library,
    /fn refresh_tray_status\([\s\S]*?refresh_recording_tray_title\(app\)/,
  );
});
