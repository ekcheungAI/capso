import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("permission, login toggle, and system-settings launch share one owner-only lease", async () => {
  const view = await readFile(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(view, /const systemActionInFlight = useRef<SystemAction \| null>\(null\)/);
  assert.match(view, /function beginSystemAction\(action: SystemAction\) \{[\s\S]*?if \(systemActionInFlight\.current !== null\) return false;[\s\S]*?systemActionInFlight\.current = action;[\s\S]*?setSystemAction\(action\)/);
  assert.match(view, /function endSystemAction\(action: SystemAction\) \{[\s\S]*?if \(systemActionInFlight\.current !== action\) return;[\s\S]*?systemActionInFlight\.current = null;[\s\S]*?setSystemAction\(null\)/);

  assert.match(view, /handleScreenRecording[\s\S]*?const action = "permission";[\s\S]*?!beginSystemAction\(action\)[\s\S]*?finally \{\s*endSystemAction\(action\)/);
  assert.match(view, /toggleLaunchAtLogin[\s\S]*?const action = "login";[\s\S]*?!beginSystemAction\(action\)[\s\S]*?finally \{\s*endSystemAction\(action\)/);
  assert.match(view, /openLoginItemSettings[\s\S]*?const action = "login_settings";[\s\S]*?!beginSystemAction\(action\)[\s\S]*?finally \{\s*endSystemAction\(action\)/);
  assert.match(view, /systemStatus\.launchAtLogin === "requiresApproval"[\s\S]*?<button[\s\S]*?disabled=\{systemAction !== null\}[\s\S]*?Open Login Items/);
});
