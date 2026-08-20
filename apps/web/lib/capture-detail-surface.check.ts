import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("capture detail surfaces only evidence-backed origin, availability and editability", async () => {
  const page = await readFile(new URL("../app/s/[id]/page.tsx", import.meta.url), "utf8");

  assert.match(page, /captureDetailPresentation\(s, account\.mode\)/);
  assert.match(page, /imageFilePresentation\(loaded \?\? s\.imageDataUrl \?\? "", s\.originalPath\)/);
  assert.match(page, /aria-label="Capture provenance and availability"/);
  assert.match(page, />Captured with</);
  assert.match(page, />Library copy</);
  assert.match(page, />Editing</);
  assert.match(page, /provenance\.sourceUrl/);
  assert.match(page, /rel="noreferrer noopener"/);
  assert.doesNotMatch(page, /fullImage\.length \/ 1024/);
});
