import assert from "node:assert/strict";
import test from "node:test";
import { matchesSearchFilters, parseSearchFilters, serializeSearchFilters } from "./search-filters.ts";

test("search URL state is bounded, reversible, and drops invalid filters", () => {
  const filters = parseSearchFilters(
    "?q=pricing+page&project=project-1&intent=competitor&date=30d",
  );
  assert.deepEqual(filters, {
    q: "pricing page",
    project: "project-1",
    intent: "competitor",
    date: "30d",
  });
  assert.equal(
    serializeSearchFilters(filters),
    "q=pricing+page&project=project-1&intent=competitor&date=30d",
  );
  assert.deepEqual(parseSearchFilters("?intent=override&date=forever"), {
    q: "",
    project: "",
    intent: "",
    date: "any",
  });
});

test("project, intent, and date filters all have to match", () => {
  const screenshot = {
    threadId: "project-1",
    intent: "competitor",
    capturedAt: "2026-07-20T00:00:00.000Z",
  };
  const now = new Date("2026-08-10T00:00:00.000Z").getTime();

  assert.equal(
    matchesSearchFilters(screenshot, { q: "", project: "project-1", intent: "competitor", date: "30d" }, now),
    true,
  );
  assert.equal(
    matchesSearchFilters(screenshot, { q: "", project: "project-2", intent: "competitor", date: "30d" }, now),
    false,
  );
  assert.equal(
    matchesSearchFilters(
      { ...screenshot, capturedAt: "2025-01-01T00:00:00.000Z" },
      { q: "", project: "project-1", intent: "competitor", date: "30d" },
      now,
    ),
    false,
  );
});
