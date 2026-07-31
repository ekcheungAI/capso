# 22 — Test Plan

Test strategy for Capso MVP. Every test group carries an ID (`T-xx-nn`) and maps to acceptance criteria in `21_ACCEPTANCE_CRITERIA.md`. Agents follow TDD for the unit/integration groups per `20_AGENT_LOOP_INSTRUCTIONS.md` §3.4. A phase in `19_BUILD_SEQUENCE.md` is not done while its mapped test groups are red.

## Tooling assumptions

| Layer | Tool | Notes |
|---|---|---|
| Unit (shared/web/worker) | Vitest | Runs in CI on every push; lives beside source |
| Web integration/E2E | Playwright | Against local Next.js + Supabase branch/local stack |
| Backend integration | Vitest + Supabase CLI local stack (or branch DB) | Real Postgres + Storage + Edge Functions, no mocks of Supabase itself |
| Model evals | Node script (`scripts/eval/`) calling the real vision model | Golden set in repo (small PNGs OK; they are test fixtures, not media assets) |
| Mac shell (Tauri) | Manual QA checklist | No automated native driver in MVP; revisit post-MVP |

AI calls in unit tests are always mocked; only T-EVAL and explicitly-marked integration tests hit real models (cost-capped, run on demand + on prompt/model change, not on every push).

## Out of scope

Load testing, multi-user concurrency, security pen-testing (RLS is covered by one integration test), Windows/Linux, billing.

---

## T-UNIT — Unit tests (Vitest, CI-blocking)

**T-UNIT-01 — Upload queue logic** → AC-OFF-01, AC-CAP-03
Pure-logic tests on the queue module (persistence layer stubbed): enqueue persists; failed upload retries with backoff and max attempts; queue drains in FIFO order on reconnect; restart restores pending items; a completed item is never re-uploaded (dedupe by capture ID); poison items surface as errored, don't block the queue.

**T-UNIT-02 — Search ranking formula** → AC-RET-01, AC-RET-02
Given fixed candidate sets with synthetic vector scores, FTS ranks, and timestamps: hybrid score combines as specified in `specs/api_contracts.md`; recency boost bounded (old strong match beats new weak match); date-filter parsing ("in March", "last week", "March 2026") produces correct UTC ranges; filter + semantic remainder split is correct for "pricing page saved in March".

**T-UNIT-03 — Chat context assembly token budgeting** → AC-CHAT-01
Given a thread of N screenshots with known summary/OCR lengths: assembled context never exceeds the budget; newest + most-relevant survive truncation first per the specified priority; OCR excerpts truncate before summaries drop; every included screenshot's ID is carried so citations (AC-CHAT-02) can only reference included items; empty thread produces a valid minimal context.

**T-UNIT-04 — Correction few-shot selection** → AC-COR-01
Given a corrections table fixture: selector returns the most relevant K corrections for a new capture (matching type/intent ranked above mismatches); 3 corrections of the same pattern all selected for a similar capture; cap on K respected; stale/superseded corrections (later re-correction of the same screenshot) excluded; zero corrections → empty few-shot block, prompt still valid.

---

## T-INT — Integration tests (Supabase branch/local stack)

**T-INT-01 — Upload → job → processed row** → AC-CAP-03, AC-CAP-04, AC-PRC-01, AC-OCR-01
End-to-end against local/branch Supabase with a mocked model endpoint returning fixed valid JSON: upload a fixture PNG via the web ingest path → assert Storage objects (original + thumb) exist → `screenshots` row created → `process_screenshot` job enqueued → worker tick processes it → row has ocr_text/summary/type/intent/confidence populated and embedding non-null → job `done`. Also: RLS check — a second test user's queries return zero rows/objects.

**T-INT-02 — Search API** → AC-RET-01, AC-RET-02, AC-DEL-01
Seed 30 processed rows with known embeddings/OCR: keyword hit returns expected row; semantic query (fixture embedding) ranks target in top 5; date filter excludes out-of-range rows; deleted screenshot (full deletion flow invoked via API) returns in **no** query, and storage listing under its prefixes is empty.

**T-INT-03 — Chat endpoint** → AC-CHAT-01, AC-CHAT-02
With mocked Sonnet-class endpoint: thread-scoped request assembles context only from that thread; `search_memory` tool round-trip executes against seeded data; cited screenshot IDs in the response all exist in the thread; messages persisted to `messages` table; streaming response terminates cleanly.

---

## T-EVAL — Model-output evaluation (run on demand + on ANY prompt or model change)

**T-EVAL-01 — Golden classification set** → AC-PRC-01, AC-SUG-01, AC-COR-01
~20 curated screenshots in `scripts/eval/golden/` spanning the taxonomy (pricing pages, dashboards, tweets, receipts, code, chat logs, design refs…), each with expected `type` and `intent` (and expected project for the correction subset). **Pass: ≥80% accuracy on type+intent.** Below 80% blocks merge of the prompt/model change. Includes the AC-COR-01 scripted sequence: apply 3 corrections, re-run the 4th similar item, assert suggestion flips.

**T-EVAL-02 — JSON schema validation on every AI response** → AC-PRC-01
Runtime (not just test-time): every vision response validated with the shared zod schema before any DB write; invalid → one repair-retry → still invalid → job failed-retryable, row untouched. Tests feed malformed fixtures (missing keys, confidence out of range, markdown-wrapped JSON) and assert no partial writes.

**T-EVAL-03 — Eval rerun discipline**
CI rule: any diff touching `prompts/` or model ID constants must include a fresh eval run result in the PR/loop report (`20_AGENT_LOOP_INSTRUCTIONS.md` §5). Eval script prints accuracy, per-item failures, and cost.

---

## T-REL — Processing reliability

**T-REL-01 — Retry behavior** → AC-PRC-01
Mock model failure (5xx/timeout) twice then success: job retries with backoff and lands `done`; attempt count recorded; total attempts ≤ configured max.

**T-REL-02 — Poison-job handling**
Job that fails every attempt (e.g. corrupt image fixture): after max attempts → status `poisoned`, error captured, Sentry event emitted, **worker continues processing other jobs** (assert a healthy job enqueued after the poison one completes).

**T-REL-03 — Idempotency**
Process the same screenshot twice (duplicate job / manual reprocess): exactly one set of result fields (overwrite, no duplicate rows/embeddings); concurrent workers claiming jobs (`SKIP LOCKED`) never double-process (assert with two parallel worker ticks).

---

## T-SRCH — Search quality (golden query set)

**T-SRCH-01 — Golden queries** → AC-RET-01
`scripts/eval/queries.json`: ≥15 (query → expected screenshot ID) pairs over a seeded corpus of ~50 real dogfood screenshots — vague memory phrasing ("that graph with red churn line"), keyword ("XQ-CAPSO-TEST-7"), and date+semantic ("pricing page saved in March"). **Pass: expected hit in top 5 for ≥80% of queries.** Rerun on any change to ranking formula, embeddings model, or FTS config.

**T-SRCH-02 — Regression tracking**
Eval script writes per-query rank to a dated results file; a change that drops any previously-passing query out of top 5 must be called out in the loop report even if aggregate still ≥80%.

---

## T-LAT — Latency thresholds

Measured per `21_ACCEPTANCE_CRITERIA.md` method (≥20 real captures, normal network). Checked manually per release (P7 gate); PostHog events (`specs/event_schema.md`) capture the same timings in dogfood for ongoing monitoring.

| Metric | Threshold | AC |
|---|---|---|
| Hotkey/region-complete → overlay visible | <1s | AC-CAP-01 |
| Capture → AI suggestion chip | <5s p50, <8s p90 | AC-SUG-01 |
| Capture → visible in web library | <10s | AC-CAP-03 |
| Search query → results rendered | <1.5s p50 | AC-RET-01 |
| Chat send → first token | <3s p50 | AC-CHAT-01 |
| Capture → keyword-searchable | <30s | AC-OCR-01 |

---

## T-QA — Manual UX QA checklist (every release / dmg build)

- [ ] **Fresh-install permission flow**: clean macOS user account, no prior grants → onboarding guides Screen Recording permission → first capture succeeds (AC-ONB-01)
- [ ] **Multi-display capture**: region + window capture on each of 2 displays with different scale factors; overlay appears on the display where capture happened
- [ ] **Dark mode**: overlay, popover, and all web views correct in dark and light; annotation colors legible in both
- [ ] **Offline**: Wi-Fi off → 3 captures → app restart → Wi-Fi on → all upload, no dupes (AC-OFF-01)
- [ ] **Annotation**: arrow/box/text/blur; download stored object and confirm flattening + irreversible blur (AC-ANN-01)
- [ ] **Deletion**: delete an annotated, assigned screenshot; verify storage listing + rows empty (AC-DEL-01)
- [ ] **Overlay behavior**: never steals focus from the active app; auto-dismiss lands capture in Inbox; "Ask AI" opens the correct thread chat
- [ ] **Hotkey conflicts**: capture hotkey works with a full-screen app frontmost; conflict with system shortcut surfaced, not silent
- [ ] **Sentry/PostHog**: force a test error and a capture event; both visible in dashboards with the correct release tag

Results recorded in BUILD_LOG.md with the release tag.

---

## AC ↔ test-group map

| AC ID | Covered by |
|---|---|
| AC-CAP-01/02 | T-LAT, T-QA |
| AC-CAP-03/04 | T-INT-01, T-LAT |
| AC-OFF-01 | T-UNIT-01, T-QA |
| AC-OCR-01 | T-INT-01, T-INT-02, T-LAT |
| AC-PRC-01 | T-INT-01, T-EVAL-02, T-REL-01 |
| AC-SUG-01..04 | T-EVAL-01, T-LAT, T-QA |
| AC-COR-01 | T-UNIT-04, T-EVAL-01 |
| AC-CHAT-01/02 | T-UNIT-03, T-INT-03, T-LAT |
| AC-RET-01/02 | T-UNIT-02, T-INT-02, T-SRCH-01 |
| AC-DEL-01 | T-INT-02, T-QA |
| AC-ANN-01 | T-QA |
| AC-ONB-01 | T-QA |
