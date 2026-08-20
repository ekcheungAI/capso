import assert from "node:assert/strict";
import test from "node:test";
import { deliveryStatusCopy } from "./popup-status.js";

const NOW = Date.parse("2026-08-12T12:00:00Z");

test("pending delivery says how many, how old and why it is still local", () => {
  assert.equal(deliveryStatusCopy({
    pending: 3,
    oldestAt: "2026-08-12T11:55:00Z",
    lastError: "Capso is offline.",
    lastResult: null,
  }, NOW), "3 waiting · oldest 5m ago — Capso is offline.");
});

test("an exact receipt retains its message and a compact relative time", () => {
  assert.equal(deliveryStatusCopy({
    pending: 0,
    oldestAt: null,
    lastError: null,
    lastResult: {
      ok: true,
      message: "Sent to Capso.",
      at: "2026-08-12T10:00:00Z",
    },
  }, NOW), "Sent to Capso. · 2h ago");
});

test("a fresh profile has an honest empty state", () => {
  assert.equal(deliveryStatusCopy({ pending: 0, lastResult: null }), "No captures yet.");
});
