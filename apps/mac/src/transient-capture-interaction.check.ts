import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Area selector owns Complete and Cancel by generation and gives live sessions precedence", async () => {
  const view = await readFile(new URL("./AreaSelector.tsx", import.meta.url), "utf8");
  assert.match(view, /const areaActionInFlight = useRef<string \| null>\(null\)/);
  assert.match(view, /let receivedAreaEvent = false;[\s\S]*?receivedAreaEvent = true;[\s\S]*?areaActionInFlight\.current = null;[\s\S]*?if \(!disposed && current && !receivedAreaEvent\) setSession\(current\)/);
  assert.match(view, /async function cancel\(\) \{[\s\S]*?const actionKey = `cancel:\$\{session\.generation\}`;[\s\S]*?!beginAreaAction\(actionKey\)[\s\S]*?finally \{\s*endAreaAction\(actionKey\)/);
  assert.match(view, /async function complete\(\) \{[\s\S]*?const actionKey = `complete:\$\{session\.generation\}`;[\s\S]*?!beginAreaAction\(actionKey\)[\s\S]*?if \(!accepted\) endAreaAction\(actionKey\)[\s\S]*?catch \{\s*endAreaAction\(actionKey\)/);
});

test("Capture timer Cancel is synchronous and a live timer event beats initial status", async () => {
  const view = await readFile(new URL("./CaptureTimer.tsx", import.meta.url), "utf8");
  assert.match(view, /const cancelGenerationInFlight = useRef<number \| null>\(null\)/);
  assert.match(view, /let receivedTimerEvent = false;[\s\S]*?receivedTimerEvent = true;[\s\S]*?if \(!disposed && !receivedTimerEvent\) setTimer\(current\)/);
  assert.match(view, /cancelTimer[\s\S]*?if \([^)]*cancelGenerationInFlight\.current !== null[^)]*\) return;[\s\S]*?cancelGenerationInFlight\.current = timer\.generation;[\s\S]*?finally \{[\s\S]*?cancelGenerationInFlight\.current = null;[\s\S]*?setBusy\(false\)/);
});

test("Freeze Cancel is generation-scoped and a live frame event beats initial status", async () => {
  const view = await readFile(new URL("./FreezeScreen.tsx", import.meta.url), "utf8");
  assert.match(view, /const cancelGenerationInFlight = useRef<number \| null>\(null\)/);
  assert.match(view, /let receivedFrameEvent = false;[\s\S]*?receivedFrameEvent = true;[\s\S]*?if \(!disposed && current && !receivedFrameEvent\)/);
  assert.match(view, /async function cancel[\s\S]*?if \([^)]*cancelGenerationInFlight\.current !== null[^)]*\) return;[\s\S]*?cancelGenerationInFlight\.current = generation;[\s\S]*?finally \{\s*if \(cancelGenerationInFlight\.current === generation\) \{\s*cancelGenerationInFlight\.current = null/);
});
