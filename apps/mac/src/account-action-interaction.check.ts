import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("account email, sign-out, and reconnect share one synchronous owner-only lease", async () => {
  const view = await readFile(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(view, /const authActionInFlight = useRef<AuthAction \| null>\(null\)/);
  assert.match(view, /function beginAuthAction\(action: AuthAction\) \{[\s\S]*?if \(authActionInFlight\.current !== null\) return false;[\s\S]*?authActionInFlight\.current = action;[\s\S]*?setAuthAction\(action\)/);
  assert.match(view, /function endAuthAction\(action: AuthAction\) \{[\s\S]*?if \(authActionInFlight\.current !== action\) return;[\s\S]*?authActionInFlight\.current = null;[\s\S]*?setAuthAction\(null\)/);

  assert.match(view, /requestSignIn[\s\S]*?const action = "email";[\s\S]*?!beginAuthAction\(action\)[\s\S]*?finally \{\s*endAuthAction\(action\)/);
  assert.match(view, /async function signOut\(\) \{[\s\S]*?const action = "sign_out";[\s\S]*?!beginAuthAction\(action\)[\s\S]*?finally \{\s*endAuthAction\(action\)/);
  assert.match(view, /async function reconnectAccount\(\) \{[\s\S]*?const action = "reconnect";[\s\S]*?!beginAuthAction\(action\)[\s\S]*?finally \{\s*endAuthAction\(action\)/);

  const listenerBlock = view.slice(
    view.indexOf('listen<AuthAccountStatus>(\n      "auth-status-changed"'),
    view.indexOf('invoke<AuthUiSnapshot>("get_auth_status")'),
  );
  assert.doesNotMatch(listenerBlock, /setAuthAction\(null\)/, "events cannot release a promise they do not own");
});
