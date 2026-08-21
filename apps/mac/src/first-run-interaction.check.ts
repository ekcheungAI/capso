import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("first run serializes mutations and ignores superseded or unmounted refreshes", async () => {
  const view = await readFile(new URL("./FirstRun.tsx", import.meta.url), "utf8");

  assert.match(view, /const actionInFlight = useRef\(false\)/);
  assert.match(view, /const refreshGate = useRef\(createLatestRequestGate\(\)\)/);
  assert.match(view, /const mounted = useRef\(true\)/);
  assert.match(view, /function beginFirstRunAction\(\) \{[\s\S]*?if \(actionInFlight\.current\) return false;[\s\S]*?actionInFlight\.current = true;[\s\S]*?setBusy\(true\)/);
  assert.match(view, /function endFirstRunAction\(\) \{[\s\S]*?actionInFlight\.current = false;[\s\S]*?if \(mounted\.current\) setBusy\(false\)/);

  assert.match(view, /const isLatest = refreshGate\.current\.begin\(\)/);
  assert.match(view, /Promise\.all[\s\S]*?if \(!isLatest\(\)\) return;[\s\S]*?setInput/);
  assert.match(view, /catch \(error\) \{\s*if \(!isLatest\(\)\) return;\s*setNote\(String\(error\)\)/);
  assert.match(view, /return \(\) => \{[\s\S]*?mounted\.current = false;[\s\S]*?refreshGate\.current\.invalidate\(\)/);

  assert.match(view, /const act = async \(\) => \{[\s\S]*?!beginFirstRunAction\(\)[\s\S]*?finally \{\s*endFirstRunAction\(\)/);
  assert.match(view, /const decline = async \(\) => \{[\s\S]*?!beginFirstRunAction\(\)[\s\S]*?finally \{\s*endFirstRunAction\(\)/);
  assert.match(view, /requestSignIn[\s\S]*?!beginFirstRunAction\(\)[\s\S]*?finally \{\s*endFirstRunAction\(\)/);
  assert.match(view, /const chooseLocalOnly = \(\) => \{\s*if \(actionInFlight\.current\) return/);
  assert.match(view, /open_screen_recording_settings[\s\S]*?if \(!mounted\.current\) return;[\s\S]*?System Settings opened/);
  assert.match(view, /request_sign_in_email[\s\S]*?if \(!mounted\.current\) return;[\s\S]*?Check your email/);
});
