import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("settings export, import, and reset share one synchronous owner-only lease", async () => {
  const view = await readFile(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(view, /const settingsTransferInFlight = useRef<SettingsTransferAction \| null>\(null\)/);
  assert.match(view, /function beginSettingsTransfer\(action: SettingsTransferAction\) \{[\s\S]*?if \(settingsTransferInFlight\.current !== null\) return false;[\s\S]*?settingsTransferInFlight\.current = action;[\s\S]*?setSettingsTransferAction\(action\)/);
  assert.match(view, /function endSettingsTransfer\(action: SettingsTransferAction\) \{[\s\S]*?if \(settingsTransferInFlight\.current !== action\) return;[\s\S]*?settingsTransferInFlight\.current = null;[\s\S]*?setSettingsTransferAction\(null\)/);

  assert.match(view, /async function exportSettings\(\) \{[\s\S]*?const action = "export";[\s\S]*?!beginSettingsTransfer\(action\)[\s\S]*?finally \{\s*endSettingsTransfer\(action\)/);
  assert.match(view, /async function importSettings\(\) \{[\s\S]*?const action = "import";[\s\S]*?settingsTransferInFlight\.current !== null[\s\S]*?window\.confirm[\s\S]*?!beginSettingsTransfer\(action\)[\s\S]*?finally \{\s*endSettingsTransfer\(action\)/);
  assert.match(view, /async function resetAllSettings\(\) \{[\s\S]*?const action = "reset";[\s\S]*?settingsTransferInFlight\.current !== null[\s\S]*?window\.confirm[\s\S]*?!beginSettingsTransfer\(action\)[\s\S]*?finally \{\s*endSettingsTransfer\(action\)/);
});
