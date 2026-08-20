import assert from "node:assert/strict";
import test from "node:test";
import { defaultSearchCandidates, searchOrderLabel } from "./search-presentation.ts";

test("filter-only search is a stable newest-first view without mutating the library", () => {
  const input = [
    { id: "old", capturedAt: "2026-01-01T00:00:00.000Z", archived: false },
    { id: "hidden", capturedAt: "2026-03-01T00:00:00.000Z", archived: true },
    { id: "new", capturedAt: "2026-02-01T00:00:00.000Z", archived: false },
  ];
  const output = defaultSearchCandidates(input);
  assert.deepEqual(output.map((candidate) => candidate.id), ["new", "old"]);
  assert.deepEqual(input.map((candidate) => candidate.id), ["old", "hidden", "new"]);
});

test("search order copy distinguishes ranked retrieval from filter-only browsing", () => {
  assert.equal(searchOrderLabel(true), "sorted by relevance");
  assert.equal(searchOrderLabel(false), "sorted newest first");
});
