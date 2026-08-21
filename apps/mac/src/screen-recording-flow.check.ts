import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const firstRun = readFileSync(new URL("./FirstRun.tsx", import.meta.url), "utf8");
const system = readFileSync(
  new URL("../src-tauri/src/system.rs", import.meta.url),
  "utf8",
);
const lib = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");

test("permission UI does not advertise an Area-only bypass that cannot save pixels", () => {
  for (const source of [app, firstRun]) {
    assert.doesNotMatch(source, /Use Area only|Area-only mode|Area capture still works|Area ready/);
    assert.doesNotMatch(source, /Access is still off/);
  }
  assert.match(app, /screenRecordingPresentation/);
  assert.match(firstRun, /screenRecordingPresentation/);
  assert.match(
    app,
    /const \[systemNotice, setSystemNotice\][\s\S]*?screenRecordingPresentation\(PREVIEW_SYSTEM_STATUS\)\.notice/,
  );
});

test("native status reports whether this build has a persistent signing identity", () => {
  assert.match(system, /enum ScreenRecordingIdentity/);
  assert.match(system, /screen_recording_identity: ScreenRecordingIdentity/);
  assert.match(system, /\/usr\/bin\/codesign/);
  assert.match(system, /Signature=adhoc/);
  assert.match(system, /TeamIdentifier=not set/);
});

test("permission recovery can restart the menu-bar process", () => {
  assert.match(lib, /fn restart_capso\(app: AppHandle\)/);
  assert.match(lib, /app\.request_restart\(\)/);
  assert.match(lib, /tauri::generate_handler!\[[\s\S]*?restart_capso/);
  assert.match(app, /invoke\("restart_capso"\)/);
  assert.match(firstRun, /invoke\("restart_capso"\)/);
});

test("an unavailable login item does not pretend an installed development build is uninstalled", () => {
  assert.doesNotMatch(app, /Unavailable outside the installed Mac app/);
  assert.match(app, /Unavailable in this development build/);
});
