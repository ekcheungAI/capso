import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createLatestRequestGate } from "./async-control.ts";

test("latest-request gate rejects superseded and invalidated History responses", () => {
  const gate = createLatestRequestGate();
  const first = gate.begin();
  const second = gate.begin();

  assert.equal(first(), false, "an older response cannot replace a newer refresh");
  assert.equal(second(), true);

  gate.invalidate();
  assert.equal(second(), false, "an unmounted History view cannot receive a late response");
});

test("History applies native snapshot, sync, warning, and errors only for the latest load", async () => {
  const view = await readFile(new URL("./HistoryView.tsx", import.meta.url), "utf8");

  assert.match(view, /const historyLoadGate = useRef\(createLatestRequestGate\(\)\)/);
  assert.match(view, /const isLatest = historyLoadGate\.current\.begin\(\)/);
  assert.match(view, /get_local_history[\s\S]*?if \(!isLatest\(\)\) return;[\s\S]*?setSnapshot\(next\)/);
  assert.match(view, /get_annotation_project_sync_status[\s\S]*?if \(!isLatest\(\)\) return;[\s\S]*?setProjectSync\(sync\)/);
  assert.match(view, /catch \(reason\) \{\s*if \(!isLatest\(\)\) return;\s*setProjectSync\(null\)/);
  assert.match(view, /catch \(reason\) \{\s*if \(!isLatest\(\)\) return;\s*setError\(String\(reason\)\)/);
  assert.match(view, /return \(\) => \{[\s\S]*?historyLoadGate\.current\.invalidate\(\)/);
});
