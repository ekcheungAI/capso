import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("pinned capture actions use presentation-scoped owner-only leases", async () => {
  const view = await readFile(new URL("./PinCapture.tsx", import.meta.url), "utf8");

  assert.match(view, /const pinActionInFlight = useRef<string \| null>\(null\)/);
  assert.match(view, /function beginPinAction\(key: string\) \{[\s\S]*?if \(pinActionInFlight\.current !== null\) return false;[\s\S]*?pinActionInFlight\.current = key;[\s\S]*?setBusy\(true\)/);
  assert.match(view, /function endPinAction\(key: string\) \{[\s\S]*?if \(pinActionInFlight\.current !== key\) return;[\s\S]*?pinActionInFlight\.current = null;[\s\S]*?setBusy\(false\)/);

  assert.match(view, /listen<PinCopyEvent>\("pin-copy-finished"[\s\S]*?endPinAction\(`copy:\$\{payload\.presentationId\}`\)/);
  assert.match(view, /listen<PinCapturePayload>\("pin-capture"[\s\S]*?pinActionInFlight\.current = null;[\s\S]*?setBusy\(false\)/);
  assert.match(view, /let receivedPinEvent = false;[\s\S]*?receivedPinEvent = true;[\s\S]*?if \(!disposed && current && !receivedPinEvent\)/);
  assert.match(view, /async function copyCapture\(\) \{[\s\S]*?const actionKey = `copy:\$\{capture\.presentationId\}`;[\s\S]*?!beginPinAction\(actionKey\)[\s\S]*?catch[\s\S]*?endPinAction\(actionKey\)/);
  assert.match(view, /async function updateCapture[\s\S]*?const actionKey = `update:\$\{capture\.presentationId\}`;[\s\S]*?!beginPinAction\(actionKey\)[\s\S]*?finally \{\s*endPinAction\(actionKey\)/);
  assert.match(view, /async function closeCapture\(\) \{[\s\S]*?const actionKey = `close:\$\{capture\.presentationId\}`;[\s\S]*?!beginPinAction\(actionKey\)[\s\S]*?finally \{\s*endPinAction\(actionKey\)/);
});
