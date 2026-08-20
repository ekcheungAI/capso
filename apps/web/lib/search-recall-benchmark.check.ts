import assert from "node:assert/strict";
import test from "node:test";
import { shot } from "./check-fixtures.ts";
import { retrieve } from "./retrieve.ts";

test("stable lexical recall covers Traditional Chinese, English and numeric memory", () => {
  const capturedAt = "2026-08-14T00:00:00.000Z";
  const library = [
    shot({ id: "monitor", capturedAt, title: "外接第二個螢幕縮放錯誤", summary: "只在第二個顯示器出現" }),
    shot({ id: "pricing", capturedAt, title: "定價頁年付切換", ocrText: "月付 年付 節省 20%" }),
    shot({ id: "mrr", capturedAt, title: "收入儀表板", ocrText: "MRR $12,480 Churn 2.1%" }),
    shot({ id: "hook", capturedAt, title: "產品啟動短片", whySaved: "啟動短片需要嘅開場 hook" }),
  ];
  const cases = [
    ["第二螢幕", "monitor"],
    ["年付", "pricing"],
    ["MRR 12,480", "mrr"],
    ["啟動短片 開場", "hook"],
  ] as const;

  for (const [query, expected] of cases) {
    assert.equal(retrieve(query, library, [])[0]?.s.id, expected, query);
  }
});
