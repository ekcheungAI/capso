import assert from "node:assert/strict";
import test from "node:test";
import { memoryRuleSummary } from "./memory-rules.ts";
import type { Correction, Screenshot } from "./store/types.ts";

const correction = (over: Partial<Correction> = {}): Correction => ({
  id: "c1",
  screenshotId: "s1",
  field: "project",
  aiValue: "old",
  userValue: "target",
  wasAiAccepted: false,
  createdAt: "2026-08-14T10:00:00.000Z",
  ...over,
});

const shot = (id: string, intent: Screenshot["intent"]): Pick<Screenshot, "id" | "intent"> => ({
  id,
  intent,
});

test("memory summary separates agreement rate from correction rules", () => {
  const corrections = [
    correction({ id: "accepted", screenshotId: "s1", wasAiAccepted: true }),
    correction({ id: "new", screenshotId: "s2", createdAt: "2026-08-14T12:00:00.000Z" }),
    correction({ id: "old", screenshotId: "s3", createdAt: "2026-08-14T11:00:00.000Z" }),
    correction({ id: "why", screenshotId: "s4", field: "why_saved" }),
  ];
  const summary = memoryRuleSummary(corrections, [
    shot("s1", "reference"),
    shot("s2", "ux_bug"),
    shot("s3", "reference"),
  ]);

  assert.deepEqual(summary, {
    accepted: 1,
    total: 3,
    acceptanceRate: 33,
    contextUsed: 3,
    rules: [{
      target: "target",
      correctionCount: 2,
      exampleIds: ["s2", "s3"],
      intents: ["ux_bug", "reference"],
    }],
  });
});

test("rule evidence is unique, newest-first and missing captures do not fabricate examples", () => {
  const summary = memoryRuleSummary([
    correction({ id: "older", screenshotId: "same", createdAt: "2026-08-14T09:00:00.000Z" }),
    correction({ id: "newer", screenshotId: "same", createdAt: "2026-08-14T13:00:00.000Z" }),
    correction({ id: "missing", screenshotId: "gone", createdAt: "2026-08-14T12:00:00.000Z" }),
  ], [shot("same", "competitor")]);

  assert.deepEqual(summary.rules[0], {
    target: "target",
    correctionCount: 3,
    exampleIds: ["same"],
    intents: ["competitor"],
  });
});

test("an empty project ledger has no invented percentage or rules", () => {
  assert.deepEqual(memoryRuleSummary([correction({ field: "tags" })], []), {
    accepted: 0,
    total: 0,
    acceptanceRate: null,
    contextUsed: 0,
    rules: [],
  });
});
