import assert from "node:assert/strict";
import test from "node:test";
import {
  SHARE_EXPIRIES,
  SHARE_TOKEN,
  shareFailureKind,
  shareInspectResult,
  shareLinkFromFragment,
  shareStatusCopy,
} from "./share-link.ts";

test("share tokens are exact 256-bit base64url bearer values", () => {
  const token = `sh_${"a".repeat(43)}`;
  assert.ok(SHARE_TOKEN.test(token));
  assert.ok(!SHARE_TOKEN.test(`sh_${"a".repeat(42)}`));
  assert.ok(!SHARE_TOKEN.test(`${token}?password=secret`));
  assert.equal(shareLinkFromFragment(`#${token}`), token);
  assert.equal(shareLinkFromFragment(`#token=${token}`), null);
});

test("public responses narrow only exact ready metadata and known terminal states", () => {
  assert.deepEqual(shareInspectResult({
    status: "ready",
    requiresPassword: true,
    expiresAt: "2026-08-14T00:00:00.000Z",
    oneTime: false,
  }), {
    status: "ready",
    requiresPassword: true,
    expiresAt: "2026-08-14T00:00:00.000Z",
    oneTime: false,
  });
  assert.equal(shareInspectResult({ status: "ready", requiresPassword: "yes" }), null);
  assert.equal(shareInspectResult({ status: "ready", requiresPassword: false, expiresAt: "nope", oneTime: false }), null);
  assert.equal(shareFailureKind({ status: "expired" }), "expired");
  assert.equal(shareFailureKind({ status: "rate_limited" }), "rate_limited");
  assert.equal(shareFailureKind({ status: "not_found", title: "must stay private" }), "not_found");
  assert.equal(shareFailureKind({ status: "ready" }), "unavailable");
  assert.equal(shareFailureKind(null), "unavailable");
});

test("owner expiry choices are bounded and public status copy never leaks metadata", () => {
  assert.deepEqual(SHARE_EXPIRIES.map((choice) => choice.seconds), [3_600, 86_400, 604_800, 2_592_000]);
  assert.equal(shareStatusCopy("expired"), "This private link has expired.");
  assert.equal(shareStatusCopy("revoked"), "This private link is no longer available.");
  assert.equal(shareStatusCopy("consumed"), "This one-time link has already been opened.");
  assert.equal(shareStatusCopy("not_found"), "This private link is invalid or unavailable.");
  assert.equal(shareStatusCopy("rate_limited"), "Too many attempts. Wait a minute before trying this private link again.");
});
