import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("recording actions are synchronous single-flight and expose exact output targets", async () => {
  const studio = await readFile(new URL("./RecordingStudio.tsx", import.meta.url), "utf8");

  assert.match(studio, /const actionInFlight = useRef\(false\)/);
  assert.match(studio, /function beginAction\(\) \{[\s\S]*?if \(actionInFlight\.current\) return false;[\s\S]*?actionInFlight\.current = true;[\s\S]*?setBusy\(true\)/);
  assert.match(studio, /function endAction\(\) \{[\s\S]*?actionInFlight\.current = false;[\s\S]*?setBusy\(false\)/);
  assert.match(studio, /if \(!canStart \|\| !beginAction\(\)\) return/);
  assert.match(studio, /if \(!nativeRuntime \|\| snapshot\.sessionId === null \|\| !active \|\| !beginAction\(\)\) return/);
  assert.match(studio, /if \(!nativeRuntime \|\| !beginAction\(\)\) return/);

  assert.match(studio, /function recordingActionLabel\(/);
  assert.match(studio, /aria-label=\{recordingActionLabel\("Open", snapshot\.output\)\}/);
  assert.match(studio, /aria-label=\{recordingActionLabel\("Show in Finder", snapshot\.output\)\}/);
  assert.match(studio, /aria-label=\{recordingActionLabel\("Edit", snapshot\.output\)\}/);
  assert.match(studio, /aria-label=\{recordingActionLabel\("Open", recording\)\}/);
  assert.match(studio, /aria-label=\{recordingActionLabel\("Show in Finder", recording\)\}/);
  assert.match(studio, /aria-label=\{recordingActionLabel\("Edit", recording\)\}/);
  assert.match(studio, /className="recording-studio__history-list" role="list"/);
  assert.match(studio, /<article key=\{recording\.id\} role="listitem">/);

  assert.match(studio, /command === "open_recording_output"[\s\S]*?Could not open recording[\s\S]*?Could not show recording in Finder/);
});
