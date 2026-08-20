import assert from "node:assert/strict";
import test from "node:test";
import { directDeliveryOutcome } from "./delivery.js";

const id = "33333333-3333-4333-8333-333333333333";

test("only an exact durable acknowledgement retires an extension capture", () => {
  assert.deepEqual(directDeliveryOutcome(201, { screenshot_id: id }, id), { kind: "delivered" });
  assert.deepEqual(directDeliveryOutcome(200, { screenshot_id: id, deduped: true }, id), { kind: "delivered" });
  assert.equal(directDeliveryOutcome(201, { screenshot_id: "other" }, id).kind, "retry");
});

test("legacy fallback is deployment-version specific, never an auth or transient-error fallback", () => {
  assert.equal(directDeliveryOutcome(501, {}, id).kind, "legacy");
  assert.equal(directDeliveryOutcome(404, {}, id).kind, "legacy");
  assert.equal(directDeliveryOutcome(401, {}, id).kind, "unpaired");
  assert.equal(directDeliveryOutcome(503, {}, id).kind, "retry");
});
