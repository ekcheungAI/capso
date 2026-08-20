import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("shortcut and Quick Access saves each acquire a synchronous renderer lease", async () => {
  const view = await readFile(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(view, /const shortcutSaveInFlight = useRef\(false\)/);
  assert.match(view, /const overlaySaveInFlight = useRef\(false\)/);

  assert.match(view, /async function saveOverlaySettings\(\) \{[\s\S]*?if \(!overlayDirty \|\| overlaySaveInFlight\.current\) return;[\s\S]*?overlaySaveInFlight\.current = true;[\s\S]*?setOverlaySaving\(true\)[\s\S]*?finally \{\s*overlaySaveInFlight\.current = false;\s*setOverlaySaving\(false\)/);
  assert.match(view, /async function save\(\) \{[\s\S]*?if \(!nativeRuntime \|\| shortcutSaveInFlight\.current\) return;[\s\S]*?shortcutSaveInFlight\.current = true;[\s\S]*?setIsSaving\(true\)[\s\S]*?finally \{\s*shortcutSaveInFlight\.current = false;\s*setIsSaving\(false\)/);
});
