import assert from "node:assert/strict";
import test from "node:test";
import * as storeBackend from "./backend.ts";

test("an explicit local-only choice wins even in a cloud-configured build", async () => {
  const selection = storeBackend as typeof storeBackend & {
    setBackendPreference?: (value: "auto" | "local") => void;
    backendPreference?: () => "auto" | "local";
  };

  assert.equal(typeof selection.setBackendPreference, "function");
  assert.equal(typeof selection.backendPreference, "function");

  selection.setBackendPreference!("local");
  assert.equal(selection.backendPreference!(), "local");
  assert.equal((await storeBackend.backend()).kind, "local");

  selection.setBackendPreference!("auto");
  assert.equal(selection.backendPreference!(), "auto");
});

test("only the explicit local value can persist as a backend preference", async () => {
  const selection = await import("./backend.ts");
  assert.equal(selection.validBackendPreference?.("local"), "local");
  assert.equal(selection.validBackendPreference?.("auto"), "auto");
  assert.equal(selection.validBackendPreference?.("remote"), "auto");
  assert.equal(selection.validBackendPreference?.(null), "auto");
});
