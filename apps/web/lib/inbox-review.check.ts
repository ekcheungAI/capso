import assert from "node:assert/strict";
import test from "node:test";
import { inboxReviewPresentation } from "./inbox-review.ts";

test("processing and failed captures never present zero as a model judgement", () => {
  assert.deepEqual(inboxReviewPresentation("processing", false, null, 0), {
    statusLabel: "Still reading",
    reason: "Capso has not made a project decision yet.",
    showConfidence: false,
  });
  assert.deepEqual(inboxReviewPresentation("unprocessed", false, null, 0), {
    statusLabel: "Couldn’t be read · Try again",
    reason: "Classification did not complete, so nothing was filed automatically.",
    showConfidence: false,
  });
});

test("sample metadata is named and never described as an automatic filing decision", () => {
  assert.deepEqual(inboxReviewPresentation("done", true, "project", 0.92), {
    statusLabel: "Sample data",
    reason: "Demo metadata is never filed automatically.",
    showConfidence: false,
  });
});

test("suggested captures explain the exact confidence routing band", () => {
  assert.deepEqual(inboxReviewPresentation("done", false, "project", 0.63), {
    statusLabel: null,
    reason: "The project match is 63%, below the 80% automatic filing threshold.",
    showConfidence: true,
  });
  assert.deepEqual(inboxReviewPresentation("done", false, "project", 0.41), {
    statusLabel: null,
    reason: "The project match is 41%, so Capso left it for you.",
    showConfidence: true,
  });
});

test("missing, unexpectedly high and invalid suggestions remain honest", () => {
  assert.deepEqual(inboxReviewPresentation("done", false, null, 0.72), {
    statusLabel: null,
    reason: "No project matched this capture, so Capso left it unfiled.",
    showConfidence: true,
  });
  assert.deepEqual(inboxReviewPresentation("done", false, "project", 0.86), {
    statusLabel: null,
    reason: "A project was suggested, but this capture is currently unfiled.",
    showConfidence: true,
  });
  assert.deepEqual(inboxReviewPresentation("done", false, "project", Number.NaN), {
    statusLabel: null,
    reason: "A project was suggested, but its confidence is unavailable.",
    showConfidence: false,
  });
});
