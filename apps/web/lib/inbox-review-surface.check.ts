import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const inbox = readFileSync(new URL("../app/inbox/page.tsx", import.meta.url), "utf8");

test("Inbox explains its routing decision and cannot race an active read", () => {
  assert.match(inbox, /inboxReviewPresentation\(/);
  assert.match(inbox, /Why it needs you:/);
  assert.match(inbox, /80% confidence or higher/);
  assert.match(inbox, /disabled=\{busy === s\.id \|\| s\.status === "processing"\}/);
  assert.match(inbox, /s\.status === "processing" \? "Still reading…"/);
  assert.doesNotMatch(inbox, /Anything above 80% confidence/);
});
