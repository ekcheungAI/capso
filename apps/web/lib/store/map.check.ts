// Relative and extensionful so this runs under plain node, matching the other
// `*.check.ts` files. Every other import here is type-only and erases.
import assert from "node:assert/strict";
import test from "node:test";
import {
  aspectFor,
  fromRow,
  hueFor,
  searchTextFor,
  threadFromRow,
  threadToRow,
  toRow,
} from "./map.ts";
import { shot } from "../check-fixtures.ts";

const USER = "00000000-0000-4000-8000-000000000001";
const ID = "11111111-1111-4111-8111-111111111111";

// ------------------------------------------------------------- status ----

test("status maps done <-> processed across the boundary", () => {
  assert.equal(toRow(shot({ id: ID, status: "done" }), USER).processing_status, "processed");
  assert.equal(fromRow({ ...toRow(shot({ id: ID, status: "done" }), USER) }).status, "done");
});

test("db 'pending' reads back as processing, since the UI has no pending state", () => {
  const row = { ...toRow(shot({ id: ID }), USER), processing_status: "pending" as const };
  assert.equal(fromRow(row).status, "processing");
});

test("unprocessed survives in both directions", () => {
  const row = toRow(shot({ id: ID, status: "unprocessed" }), USER);
  assert.equal(row.processing_status, "unprocessed");
  assert.equal(fromRow(row).status, "unprocessed");
});

// ------------------------------------------------------ round-tripping ----

test("a fully-populated capture round-trips every persisted field", () => {
  const s = shot({
    id: ID,
    title: "Stripe pricing",
    summary: "Three tiers with an annual toggle",
    whySaved: "steal the toggle",
    ocrText: "Pro $29/mo",
    intent: "competitor",
    type: "web_page",
    threadId: "22222222-2222-4222-8222-222222222222",
    suggestedThreadId: "33333333-3333-4333-8333-333333333333",
    confidence: 0.72,
    status: "done",
    simulated: true,
    assignmentSource: "user_corrected",
    source: "extension",
    archived: true,
    pageUrl: "https://stripe.com/pricing",
    pageTitle: "Pricing",
    sourceApp: "Chrome",
    tags: ["pricing", "saas"],
    userTags: ["swipe"],
    ocrSource: "llm",
    ocrLangs: ["en"],
    contentHash: "abc123",
    originalPath: `${USER}/${ID}.png`,
    thumbPath: `${USER}/${ID}.webp`,
    width: 1200,
    height: 800,
  });

  const back = fromRow(toRow(s, USER));

  for (const k of [
    "id", "title", "summary", "whySaved", "ocrText", "intent", "type", "threadId",
    "suggestedThreadId", "confidence", "status", "simulated", "assignmentSource",
    "source", "archived", "pageUrl", "pageTitle", "sourceApp", "tags", "userTags",
    "ocrSource", "ocrLangs", "contentHash", "originalPath", "thumbPath",
    "width", "height", "capturedAt",
  ] as const) {
    assert.deepEqual(back[k], s[k], `field ${k} did not survive the round trip`);
  }
});

test("toRow carries the owner, because RLS matches on it", () => {
  assert.equal(toRow(shot({ id: ID }), USER).user_id, USER);
});

test("a capture whose bytes have not uploaded yet round-trips a null path", () => {
  const row = toRow(shot({ id: ID, originalPath: null, thumbPath: null }), USER);
  assert.equal(row.storage_path, null);
  assert.equal(fromRow(row).originalPath, null);
});

test("snake_case is what actually reaches Postgres", () => {
  const row = toRow(shot({ id: ID, whySaved: "w", threadId: null, ocrText: "o" }), USER);
  assert.ok("why_saved" in row && "project_thread_id" in row && "ocr_text" in row);
  assert.ok(!("whySaved" in row) && !("threadId" in row));
});

// ---------------------------------------------------------- derivation ----

test("aspect derivation matches the thresholds capture.tsx already writes", () => {
  // capture.tsx:585 — ratio > 1.2 ? wide : ratio < 0.85 ? tall : square.
  // Divergence here would silently reshape a capture on reload.
  assert.equal(aspectFor(1600, 900), "wide");
  assert.equal(aspectFor(800, 1600), "tall");
  assert.equal(aspectFor(1000, 1000), "square");
});

test("aspect falls back to wide when dimensions are unknown", () => {
  assert.equal(aspectFor(null, null), "wide");
});

test("hue is deterministic, stable and a legal degree", () => {
  const a = hueFor(ID);
  assert.equal(a, hueFor(ID));
  assert.ok(Number.isInteger(a) && a >= 0 && a < 360);
  assert.notEqual(hueFor(ID), hueFor("44444444-4444-4444-8444-444444444444"));
});

// -------------------------------------------------------- search_text ----

test("search_text gathers every field a person might recall", () => {
  const t = searchTextFor(
    shot({ id: ID, title: "Stripe", summary: "annual toggle", whySaved: "steal it",
           ocrText: "$29", tags: ["pricing"], userTags: ["swipe"] }),
  );
  for (const w of ["stripe", "annual", "steal", "29", "pricing", "swipe"]) {
    assert.ok(t.toLowerCase().includes(w), `search_text missing ${w}`);
  }
});

test("CJK is segmented, so 定價 can match a document containing 定價頁面", () => {
  // The whole reason search_tsv uses `simple` over a pre-segmented column
  // (10 §Amendment loop 12): unsegmented, the two never match.
  const t = searchTextFor(shot({ id: ID, ocrText: "定價頁面" }));
  assert.ok(/(^|\s)定價(\s|$)/.test(t), `expected 定價 as its own token, got: ${t}`);
});

// ------------------------------------------------------------- threads ----

test("threads round-trip and carry their owner", () => {
  const t = {
    id: ID, name: "Competitor research", description: "pricing pages",
    createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
    archived: false,
  };
  const row = threadToRow(t, USER);
  assert.equal(row.user_id, USER);
  assert.deepEqual(threadFromRow(row), t);
});

test("archived threads use archived_at, since the column is a timestamp not a flag", () => {
  const t = {
    id: ID, name: "Old", description: "",
    createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
    archived: true,
  };
  assert.notEqual(threadToRow(t, USER).archived_at, null);
  assert.equal(threadFromRow(threadToRow(t, USER)).archived, true);
});
