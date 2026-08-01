import assert from "node:assert/strict";
import test from "node:test";
import { resurface } from "./resurface.ts";
import { shot } from "./check-fixtures.ts";
import type { Revisit } from "@/lib/store";

const NOW = Date.parse("2026-08-01T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 864e5).toISOString();
const names = () => "Pricing redesign";

test("nothing younger than the forgetting window is resurfaced", () => {
  // A capture saved this morning has not been forgotten yet, and a shelf that
  // is always full is a backlog rather than a memory.
  const fresh = shot({ id: "fresh", capturedAt: daysAgo(2) });
  assert.deepEqual(resurface([fresh], [], names, 3, NOW), []);
});

test("a capture you have already opened is not resurfaced", () => {
  const s = shot({ id: "a", capturedAt: daysAgo(90) });
  const seen = [{ id: "r1", screenshotId: "a", kind: "opened_detail", createdAt: daysAgo(1) } as Revisit];
  assert.deepEqual(resurface([s], seen, names, 3, NOW), []);
});

test("a capture whose classification failed is never resurfaced", () => {
  // It has no summary and no OCR text — surfacing it would be showing the user
  // an unreadable card and calling it a suggestion.
  const broken = shot({ id: "x", capturedAt: daysAgo(90), status: "unprocessed" });
  assert.deepEqual(resurface([broken], [], names, 3, NOW), []);
});

test("every resurfaced capture carries a reason", () => {
  const items = resurface(
    [
      shot({ id: "auto", capturedAt: daysAgo(40), threadId: "t1", assignmentSource: "auto" }),
      shot({ id: "noted", capturedAt: daysAgo(50), whySaved: "the annual toggle" }),
      shot({ id: "bare", capturedAt: daysAgo(60) }),
    ],
    [],
    names,
    3,
    NOW,
  );
  assert.equal(items.length, 3);
  for (const i of items) assert.ok(i.reason.trim().length > 0, `${i.s.id} had no reason`);
});

test("the reason is specific to why this capture was picked", () => {
  const auto = resurface(
    [shot({ id: "a", capturedAt: daysAgo(40), threadId: "t1", assignmentSource: "auto" })],
    [],
    names,
    3,
    NOW,
  );
  assert.match(auto[0]!.reason, /Capso seated this in Pricing redesign/);

  const noted = resurface(
    [shot({ id: "b", capturedAt: daysAgo(40), whySaved: "the annual toggle" })],
    [],
    names,
    3,
    NOW,
  );
  assert.match(noted[0]!.reason, /the annual toggle/);

  const unfiled = resurface([shot({ id: "c", capturedAt: daysAgo(40) })], [], names, 3, NOW);
  assert.match(unfiled[0]!.reason, /still without a project/);
});

test("oldest first, capped at the limit", () => {
  const items = resurface(
    [
      shot({ id: "newer", capturedAt: daysAgo(20) }),
      shot({ id: "oldest", capturedAt: daysAgo(200) }),
      shot({ id: "middle", capturedAt: daysAgo(60) }),
    ],
    [],
    names,
    2,
    NOW,
  );
  assert.deepEqual(
    items.map((i) => i.s.id),
    ["oldest", "middle"],
  );
});
