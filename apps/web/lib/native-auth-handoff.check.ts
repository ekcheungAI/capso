import assert from "node:assert/strict";
import test from "node:test";

import { nativeAuthHandoff } from "./native-auth-handoff.ts";

const STATE =
  "state_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

test("an exact code and high-entropy state become one token-free Capso callback", () => {
  const result = nativeAuthHandoff(
    new URLSearchParams({ code: "opaque+/=:!", state: STATE }),
  );

  assert.equal(result.kind, "ready");
  if (result.kind !== "ready") return;
  const callback = new URL(result.openUrl);
  assert.equal(callback.protocol, "capso:");
  assert.equal(callback.host, "auth");
  assert.equal(callback.pathname, "/callback");
  assert.deepEqual([...callback.searchParams.keys()], ["code", "state"]);
  assert.equal(callback.searchParams.get("code"), "opaque+/=:!");
  assert.equal(callback.searchParams.get("state"), STATE);
  assert.equal(callback.hash, "");
  assert.ok(!result.openUrl.includes("access_token"));
  assert.ok(!result.openUrl.includes("refresh_token"));
});

test("duplicates, token-shaped fields, malformed values, and provider errors never open the app", () => {
  const invalid = [
    "",
    `code=ok&state=${STATE}&state=second`,
    `code=ok&state=${STATE}&access_token=secret`,
    `code=ok&state=${STATE}#refresh_token=secret`,
    `code=%00&state=${STATE}`,
    "code=ok&state=short",
    "error=access_denied&error_description=private-provider-message",
  ];

  for (const query of invalid) {
    const result = nativeAuthHandoff(new URLSearchParams(query));
    assert.deepEqual(result, {
      kind: "invalid",
      message: "This sign-in link is invalid or expired. Start again from the Capso app.",
    });
    assert.ok(!JSON.stringify(result).includes("private-provider-message"));
  }
});

test("attribute-breaking visible characters remain percent-encoded in the callback URL", () => {
  const result = nativeAuthHandoff(
    new URLSearchParams({ code: `\" autofocus onfocus=\"alert(1)`, state: STATE }),
  );
  assert.equal(result.kind, "ready");
  if (result.kind !== "ready") return;
  assert.ok(!result.openUrl.includes('"'));
  assert.equal(
    new URL(result.openUrl).searchParams.get("code"),
    `\" autofocus onfocus=\"alert(1)`,
  );
});
