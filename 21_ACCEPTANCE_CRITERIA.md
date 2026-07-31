# 21 — Acceptance Criteria

Testable acceptance criteria for Capso MVP, Given/When/Then with hard numbers. Grouped by build phase from `19_BUILD_SEQUENCE.md`. Each criterion has an ID (`AC-xx-nn`) referenced by `22_TEST_PLAN.md`. A phase's "done criteria" in 19 means its AC group passes.

## Assumptions

- "Normal network" = ≥10 Mbps up, <100 ms RTT to Supabase region.
- Latency percentiles measured over ≥20 consecutive real captures on the dev Mac, not synthetic mocks.
- All criteria are single-user (owner account) — multi-user is out of scope.
- Timings start from user-observable trigger (hotkey release, click, Enter) unless stated.

## Out of scope

Billing, links/PDFs, scrolling capture, recording, team features, mobile. No AC exists for parked features by design.

---

## P2 — Capture

**AC-CAP-01 — Hotkey to overlay latency**
- Given the app is running and Screen Recording permission is granted
- When the user presses the capture hotkey and completes a region selection
- Then the floating overlay appears within **<1s** of selection completing, showing the capture thumbnail, and the image is on the clipboard.

**AC-CAP-02 — Window capture**
- Given the app is running
- When the user triggers window-capture mode and clicks a window
- Then that window's contents (and only that window) are captured, overlay appears per AC-CAP-01.

**AC-CAP-03 — Capture reaches library**
- Given a capture on normal network
- When the overlay appears (confirm, ignore, or auto-dismiss — any path)
- Then the image is visible in the web library within **<10s** of capture, with a thumbnail and correct timestamp, and a `screenshots` row + Storage objects (original + thumb) exist.

**AC-CAP-04 — Web drag-drop ingest**
- Given the user is signed in on the web app
- When they drag-drop or paste a PNG/JPG
- Then it enters the identical pipeline (row + storage + processing job) and appears in the library immediately with a "processing" state.

**AC-OFF-01 — Offline capture queues and recovers**
- Given the Mac has no network connectivity
- When the user makes 3 captures (overlay still appears; AI chip shows "will process when online")
- Then all 3 are persisted to the local queue, survive an app restart, and When connectivity is restored, all 3 upload automatically within **60s** of reconnect with zero user action and zero duplicates.

---

## P3 — Processing

**AC-OCR-01 — Captured text is searchable**
- Given a capture whose image contains the known unique string "XQ-CAPSO-TEST-7"
- When processing completes (job status `done`)
- Then a keyword search for "XQ-CAPSO-TEST-7" returns that screenshot, and this is achievable within **30s** of capture on normal network (capture → processed → indexed).

**AC-PRC-01 — Structured output present**
- Given any successfully processed screenshot
- When its detail view is opened
- Then `ocr_text`, `summary`, `type`, `intent`, `confidence`, and `why_saved` are all populated and `confidence` ∈ [0,1]. Malformed AI JSON never reaches the row (schema-validated per 22_TEST_PLAN.md T-EVAL-02).

---

## P4 — Suggestion & threads

**AC-SUG-01 — Suggestion chip latency**
- Given ≥1 project exists and a capture is made on normal network
- When the overlay is showing
- Then the AI suggestion chip (suggested project name + why) appears in **<5s p50 / <8s p90** from capture completion. Past 8s, the overlay shows "processing — will land in Inbox" and never blocks dismissal.

**AC-SUG-02 — One-click confirm**
- Given the suggestion chip is visible on the overlay
- When the user clicks Confirm (exactly one click, no submenu)
- Then the screenshot is assigned to that project's thread, the overlay dismisses, and the assignment is visible in the web thread view on next load.

**AC-SUG-03 — Ignore routes to Inbox**
- Given the overlay is visible (with or without a suggestion yet)
- When the user clicks Ignore, or the overlay auto-dismisses with no action
- Then the screenshot lands in the Inbox (unassigned), not in any project, and is not lost.

**AC-SUG-04 — Confidence routing**
- Given processed captures with confidence ≥0.8 / 0.5–0.8 / <0.5
- When routing runs
- Then they are respectively auto-assigned (with visible one-click undo on overlay), surfaced as a suggestion requiring confirm, and sent to Inbox — matching the locked thresholds.

**AC-COR-01 — Correction learning**
- Given the user has corrected the same kind of misassignment 3 times (e.g. moved "competitor pricing" captures from project A to project B)
- When a 4th similar capture is processed (similar = same type/intent and matching content per corrections few-shot selector)
- Then the suggestion reflects the correction (suggests project B), via few-shot context injection — no fine-tuning. Verified with a scripted 3-correction sequence in the eval set.

---

## P5 — Thread chat

**AC-CHAT-01 — Chat uses thread screenshots**
- Given a project thread containing ≥5 processed screenshots, one of which contains a distinctive fact (e.g. a price "$49/mo")
- When the user asks a question in that thread whose answer is on that screenshot ("what was their monthly price?")
- Then the answer contains the fact and is grounded in that thread's screenshots, with first token in **<3s p50**.

**AC-CHAT-02 — Citations name sources**
- Given AC-CHAT-01's scenario
- When the answer renders
- Then it explicitly names/links which screenshot(s) it used (rendered as identifiable references resolving to real screenshot detail views), and cited IDs actually exist in that thread.

---

## P6 — Search & deletion

**AC-RET-01 — Vague memory query, top 5**
- Given the golden query set from `22_TEST_PLAN.md` (vague natural-language memory queries with known target screenshots, e.g. "that dashboard with the red churn graph")
- When each query is run in search
- Then the target screenshot appears in the **top 5** results for the pass-rate threshold defined in 22_TEST_PLAN.md, and **p50 search latency <1.5s**.

**AC-RET-02 — Date + semantic query**
- Given a screenshot of a pricing page captured in March
- When the user searches "pricing page saved in March"
- Then results are filtered/boosted to March captures and the target appears in the top 5; the parsed date range is visible as an applied filter chip the user can remove.

**AC-DEL-01 — Hard delete is complete**
- Given a processed, assigned, annotated screenshot
- When the user deletes it (with confirm dialog) 
- Then the original Storage object, thumbnail object, `screenshots` row, embedding, and any annotation object are all gone — verified by listing the storage prefixes (zero objects) and querying the rows (zero rows) — and it no longer appears in search, thread, Inbox, or chat context. No orphaned jobs remain queued for it.

---

## P7 — Annotation & polish

**AC-ANN-01 — Annotation tools work and flatten**
- Given a fresh capture open in the annotation editor
- When the user adds an arrow, a box, a text label, and a blur region, then saves
- Then all four render correctly, the uploaded stored image is the **flattened** annotated bitmap (blur irreversibly applied — verified by downloading the stored object and confirming blurred pixels), and the annotated version is what appears in library/threads.

**AC-ONB-01 — Fresh install to first capture**
- Given a fresh install on a Mac that has never granted permissions
- When the user follows onboarding
- Then they are guided through Screen Recording permission, sign-in, and hotkey, and complete a first successful capture (AC-CAP-01/03 pass) without consulting external docs.

---

## Cross-reference index

| Phase | AC IDs | Verified by (22_TEST_PLAN.md) |
|---|---|---|
| P2 | AC-CAP-01..04, AC-OFF-01 | T-UNIT-01, T-INT-01, T-QA manual |
| P3 | AC-OCR-01, AC-PRC-01 | T-INT-01, T-EVAL-01..03, T-REL-01..03 |
| P4 | AC-SUG-01..04, AC-COR-01 | T-UNIT-04, T-EVAL-01, T-LAT table |
| P5 | AC-CHAT-01..02 | T-UNIT-03, T-INT-03, T-LAT table |
| P6 | AC-RET-01..02, AC-DEL-01 | T-SRCH-01..02, T-INT-02 |
| P7 | AC-ANN-01, AC-ONB-01 | T-QA manual checklist |
