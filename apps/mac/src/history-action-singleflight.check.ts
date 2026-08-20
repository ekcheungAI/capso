import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("History owns every mutation with one synchronous keyed action lease", async () => {
  const view = await readFile(new URL("./HistoryView.tsx", import.meta.url), "utf8");

  assert.match(view, /const actionInFlight = useRef<string \| null>\(null\)/);
  assert.match(view, /function beginHistoryAction\(key: string\) \{[\s\S]*?if \(actionInFlight\.current !== null\) return false;[\s\S]*?actionInFlight\.current = key;[\s\S]*?setBusy\(key\)/);
  assert.match(view, /function endHistoryAction\(key: string\) \{[\s\S]*?if \(actionInFlight\.current !== key\) return;[\s\S]*?actionInFlight\.current = null;[\s\S]*?setBusy\(null\)/);

  assert.match(view, /async function combine\(\) \{[\s\S]*?const actionKey = "combine";[\s\S]*?!beginHistoryAction\(actionKey\)[\s\S]*?finally \{\s*endHistoryAction\(actionKey\)/);
  assert.match(view, /async function frameForSocial\(\) \{[\s\S]*?const actionKey = "frame";[\s\S]*?!beginHistoryAction\(actionKey\)[\s\S]*?finally \{\s*endHistoryAction\(actionKey\)/);
  assert.match(view, /async function removeFromHistory[\s\S]*?const actionKey = `remove:\$\{capture\.id\}`;[\s\S]*?!beginHistoryAction\(actionKey\)[\s\S]*?finally \{\s*endHistoryAction\(actionKey\)/);
  assert.match(view, /async function clearHistory\(\) \{[\s\S]*?const actionKey = "clear-history";[\s\S]*?!beginHistoryAction\(actionKey\)[\s\S]*?finally \{\s*endHistoryAction\(actionKey\)/);
  assert.match(view, /async function undoHistoryRemoval\(\) \{[\s\S]*?const actionKey = "undo-history";[\s\S]*?!beginHistoryAction\(actionKey\)[\s\S]*?finally \{\s*endHistoryAction\(actionKey\)/);
  assert.match(view, /async function copyOcrLink[\s\S]*?const actionKey = `ocr-copy-link:\$\{linkIndex\}`;[\s\S]*?!beginHistoryAction\(actionKey\)[\s\S]*?finally \{\s*endHistoryAction\(actionKey\)/);

  assert.match(view, /aria-pressed=\{compositionMode === "combine"\}[\s\S]*?disabled=\{busy !== null\}/);
  assert.match(view, /aria-pressed=\{compositionMode === "frame"\}[\s\S]*?disabled=\{busy !== null\}/);
});
