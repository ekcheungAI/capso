import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("packaged webviews enable a capture-preview-safe CSP", async () => {
  const config = JSON.parse(
    await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  ) as { app?: { security?: {
    csp?: Record<string, string> | null;
    devCsp?: Record<string, string> | null;
  } } };
  const csp = config.app?.security?.csp;

  assert.ok(csp, "CSP must not be disabled");
  assert.match(csp["default-src"] ?? "", /'self'/);
  assert.match(csp["connect-src"] ?? "", /ipc:/);
  assert.match(csp["img-src"] ?? "", /asset:/);
  assert.match(csp["img-src"] ?? "", /http:\/\/asset\.localhost/);
  assert.equal(csp["object-src"], "'none'");

  const devCsp = config.app?.security?.devCsp;
  assert.ok(devCsp, "development CSP must be explicit");
  assert.match(devCsp["connect-src"] ?? "", /ws:\/\/localhost:1420/);
});
