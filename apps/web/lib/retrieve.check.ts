import assert from "node:assert/strict";
import test from "node:test";
import { retrieve, terms } from "./retrieve.ts";
import { shot } from "./check-fixtures.ts";
import type { Revisit, Screenshot, Thread } from "@/lib/store";

/**
 * Runs under plain node — `pnpm --filter web test`. No framework, because the
 * only thing worth pinning here is the ranking behaviour, and every one of
 * these assertions failed against the implementation that shipped before it.
 */

const threads: Thread[] = [];
const ids = (r: { s: Screenshot }[]) => r.map((x) => x.s.id);

test("a Latin term does not match inside another word", () => {
  // `includes` scored both of these. Only the first is a real hit.
  const hits = retrieve("cat", [shot({ id: "yes", title: "Cat photos" }), shot({ id: "no", title: "Duplicate rows" })], threads);
  assert.deepEqual(ids(hits), ["yes"]);
});

test("a Latin term still matches a word it prefixes", () => {
  // Cheapest stand-in for stemming: "design" must reach "designs".
  const hits = retrieve("design", [shot({ id: "a", title: "Designs worth stealing" })], threads);
  assert.deepEqual(ids(hits), ["a"]);
});

test("CJK keeps substring matching", () => {
  const hits = retrieve("定價", [shot({ id: "a", ocrText: "新的定價頁面" })], threads);
  assert.deepEqual(ids(hits), ["a"]);
});

test("a capture matching nothing is excluded regardless of recency", () => {
  // The old cutoff was `score > 2`, exactly the maximum recency bonus, so a
  // brand-new capture that matched no term sat right on the boundary.
  const hits = retrieve("pricing", [shot({ id: "fresh", title: "Unrelated" })], threads);
  assert.deepEqual(hits, []);
});

test("one field cannot outscore a better field by repeating the query", () => {
  const title = shot({ id: "title", title: "Mobile pricing page" });
  const blob = shot({ id: "blob", ocrText: "mobile pricing page ".repeat(50) });
  assert.equal(ids(retrieve("mobile pricing page", [blob, title], threads))[0], "title");
});

test("revisits break a tie", () => {
  const now = new Date().toISOString();
  const a = shot({ id: "a", title: "Pricing page", capturedAt: now });
  const b = shot({ id: "b", title: "Pricing page", capturedAt: now });
  const revisits = [1, 2, 3, 4].map(
    (n) => ({ id: `r${n}`, screenshotId: "b", kind: "opened_detail", createdAt: now }) as Revisit,
  );
  assert.equal(ids(retrieve("pricing", [a, b], threads, 12, revisits))[0], "b");
  // …and does not on its own promote a capture that matches nothing.
  assert.deepEqual(retrieve("unrelated", [a, b], threads, 12, revisits), []);
});

test("terms() keeps numbers and drops single Han only when longer ones exist", () => {
  assert.ok(terms("68%").includes("68"));
  // ICU segments this as 定價 + 頁; the lone character is dropped because a
  // longer one survives — 頁 matches almost any Chinese text.
  assert.deepEqual(terms("定價頁"), ["定價"]);
  // …but a one-character query still returns something rather than nothing.
  assert.deepEqual(terms("頁"), ["頁"]);
});
