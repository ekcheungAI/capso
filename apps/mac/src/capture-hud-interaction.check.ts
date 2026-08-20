import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Capture HUD owns one launch until failure or the HUD is explicitly reopened", async () => {
  const hud = await readFile(new URL("./CaptureHud.tsx", import.meta.url), "utf8");

  assert.match(hud, /const captureLaunchInFlight = useRef\(false\)/);
  assert.match(hud, /function beginCaptureLaunch\(\) \{[\s\S]*?if \(captureLaunchInFlight\.current \|\| loading\) return false;[\s\S]*?captureLaunchInFlight\.current = true;[\s\S]*?setBusy\(true\)/);
  assert.match(hud, /function releaseCaptureLaunch\(\) \{[\s\S]*?captureLaunchInFlight\.current = false;[\s\S]*?setBusy\(false\)/);
  assert.match(hud, /listen\("capture-hud-opened",[\s\S]*?captureLaunchInFlight\.current = false;[\s\S]*?setBusy\(false\)/);
  assert.match(hud, /async function startCapture\(\) \{\s*if \(!beginCaptureLaunch\(\)\) return/);
  assert.match(hud, /async function startPreviousArea\(\) \{\s*if \(!previousArea\.available \|\| !beginCaptureLaunch\(\)\) return/);
  assert.match(hud, /catch \(reason\) \{[\s\S]*?Could not start capture[\s\S]*?releaseCaptureLaunch\(\)/);
  assert.match(hud, /Could not capture Previous Area[\s\S]*?releaseCaptureLaunch\(\)/);

  assert.match(hud, /className="capture-hud__mode"[\s\S]*?disabled=\{busy \|\| loading\}/);
  assert.match(hud, /aria-label="Include window shadow"[\s\S]*?disabled=\{busy \|\| loading\}/);
  assert.match(hud, /aria-label="Window padding"[\s\S]*?disabled=\{busy \|\| loading\}/);
  assert.match(hud, /aria-label="Window background"[\s\S]*?disabled=\{busy \|\| loading\}/);
  assert.match(hud, /data-delay=\{delay\}[\s\S]*?disabled=\{busy \|\| loading\}/);
});
