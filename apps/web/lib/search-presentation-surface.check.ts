import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../app/search/page.tsx", import.meta.url), "utf8");

test("Search describes the retrieval it actually runs and labels filter-only order honestly", () => {
  assert.match(page, /titles, OCR text, your notes, tags, projects and recent activity/);
  assert.match(page, /defaultSearchCandidates\(screenshots\)/);
  assert.match(page, /searchOrderLabel\(Boolean\(\(asked && answer\) \|\| debouncedQ\)\)/);
  assert.doesNotMatch(page, /searches the image/i);
  assert.doesNotMatch(page, /words, images/i);
  assert.doesNotMatch(page, /shown\.length > 0 && " · sorted by relevance"/);
});
