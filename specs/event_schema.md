# Capso — Analytics Event Schema (v1)

**This file is the source of truth for event names.** Code must use these exact strings. Sink: PostHog (Mac + web via posthog-js/rust client; server-side events sent from Supabase Edge Functions via `posthog-node` with the shared `user_id` as distinct id). Metric definitions live in ../17_METRICS_AND_ANALYTICS.md — this file maps each event to the metric(s) that consume it.

## Assumptions

- One PostHog project; `platform` property separates surfaces. Session replay off in MVP.
- Server events are attributed to the owning user, not an anonymous id, so funnels stitch across Mac/web/server.

## Out of scope

- A/B experiment events, billing events, digest email opens (only in-app `digest_viewed`).

## PII rule (hard)

**NEVER send to analytics:** OCR text, summaries, image bytes or URLs, thread/project names, screenshot titles, chat message text, or raw search query text. Free-text user input is represented as `*_hash` (SHA-256, truncated 16 hex chars) and/or `*_length` (int) only. Storage paths, signed URLs, and filenames are also banned (they can embed identifiers). Violations are release blockers.

## Common properties (every event)

| Property | Type | Notes |
|---|---|---|
| `user_id` | string (uuid) | Supabase auth uid; PostHog distinct id |
| `platform` | enum `mac \| web \| server` | Where the event was emitted |
| `app_version` | string | Mac app or web build version (server: function version) |
| `session_id` | string (uuid) | Client session; server events echo the triggering client's session when known, else `null` |

## Event dictionary

Property lists below are in addition to the common block. Types: `str`, `int`, `bool`, `float`, `enum`.

### Capture

| Event | Platform | Trigger point | Properties | Consumed by (../17_METRICS_AND_ANALYTICS.md) |
|---|---|---|---|---|
| `capture_started` | mac, web | Hotkey pressed / drop begins, before picker resolves | `source: enum(hotkey_region\|hotkey_window\|drag\|clipboard\|web_upload)` | Capture funnel top; captures/day (activation + habit metric) |
| `capture_completed` | mac, web | Image bytes exist locally (picker done, not yet uploaded) | `source: enum(as above)`, `duration_ms: int` (started→completed), `annotated: bool`, `bytes: int`, `width: int`, `height: int` | Captures/day; capture success rate (vs `capture_failed`); source mix |
| `capture_failed` | mac, web | Picker cancelled, empty output, disk error (edge_cases.md §1) | `source: enum`, `reason: enum(user_cancelled\|empty_output\|permission_missing\|disk\|other)` | Capture failure rate; permission-missing count feeds onboarding health |
| `annotation_used` | mac | Annotation editor "Save" clicked | `tools_used: str[] of arrow\|box\|text\|blur`, `duration_ms: int`, `blur_used: bool` | Annotation adoption; blur usage informs privacy roadmap (permission_model.md post-MVP) |

### Upload & processing

| Event | Platform | Trigger point | Properties | Consumed by |
|---|---|---|---|---|
| `upload_succeeded` | server | `/v1/ingest` accepts the finalized upload | `source: enum`, `bytes: int`, `deduped: bool`, `queue_delay_ms: int` (captured_at→ingest) | Sync reliability; offline-queue latency; dedupe rate |
| `upload_failed` | mac, web | A storage upload attempt fails (per attempt) | `reason: enum(network\|auth_expired\|quota\|other)`, `attempt: int`, `will_retry: bool` | Sync reliability alert threshold |
| `ai_processing_completed` | server | process-screenshot job reaches `done` (or terminal `failed`) | `status: enum(done\|unprocessed\|failed)`, `duration_ms: int` (ingest→done), `attempts: int`, `confidence: float`, `intent: enum(design_inspiration\|ux_bug\|competitor\|marketing_hook\|content_idea\|reference\|other)`, `ocr_length: int`, `schema_retry: bool` | p50/p95 processing latency (3–5s overlay SLA); AI failure rate; intent distribution |

### Suggestion loop

| Event | Platform | Trigger point | Properties | Consumed by |
|---|---|---|---|---|
| `ai_suggestion_shown` | mac, web | Suggestion chip / auto-assign result rendered to user | `mode: enum(auto_assign\|suggest\|inbox)`, `confidence: float`, `latency_ms: int` (capture→chip), `suggested_is_new_thread: bool` | Suggestion latency SLA; band distribution (tunes 0.5/0.8 thresholds) |
| `ai_suggestion_accepted` | server | `/v1/suggestion/respond action=accept` (or auto-assign left untouched is NOT an event — measured as absence of correction) | `confidence: float`, `mode: enum(auto_assign_edit\|suggest)` | **Suggestion acceptance rate — the core AI-quality metric** |
| `ai_suggestion_corrected` | server | `/v1/suggestion/respond action=correct`, or web triage picks ≠ suggestion | `confidence: float`, `surface: enum(overlay\|web_inbox\|card_edit)`, `to_new_thread: bool` | Correction rate; few-shot flywheel health |
| `ai_suggestion_ignored` | server | `action=ignore` or overlay timeout with a live suggestion | `confidence: float`, `via_timeout: bool` | Ignore rate; overlay UX tuning |

### Threads & chat

| Event | Platform | Trigger point | Properties | Consumed by |
|---|---|---|---|---|
| `thread_created` | mac, web, server | New project thread row created | `origin: enum(manual\|suggestion_accept\|inbox_triage\|chat)` | Thread growth; org-structure adoption |
| `thread_confirmed` | mac | User confirms an AI-proposed new thread on the overlay | `confidence: float` | New-thread suggestion quality |
| `chat_message_sent` | mac, web | User message submitted to `/v1/chat` | `thread_id_hash: str`, `message_length: int`, `has_attachments: bool` | Chat engagement (WAU chat); retrieval funnel top |
| `chat_screenshot_referenced` | server | Assistant answer surfaces a screenshot (attachment or search_memory hit) | `via: enum(attachment\|search_memory)`, `result_count: int` | **Memory-payoff metric**; search_memory hit rate |

### Search & revisit

| Event | Platform | Trigger point | Properties | Consumed by |
|---|---|---|---|---|
| `search_performed` | web, mac | `/v1/search` issued | `query_hash: str`, `query_length: int`, `filters_used: str[]`, `result_count: int`, `zero_results: bool` | Search usage; zero-result rate (retrieval quality) |
| `search_result_clicked` | web, mac | Result card opened | `query_hash: str`, `rank: int`, `score: float` | Search CTR; rank quality (MRR) |
| `screenshot_revisited` | web, mac | Screenshot detail view opened (any path: search, thread, chat reference) | `via: enum(search\|thread\|chat_reference\|inbox\|direct)`, `age_days: int` (captured→revisit) | **North-star input: % of captures revisited ≥1× (../17_METRICS_AND_ANALYTICS.md)** |
| `screenshot_deleted` | server | `delete_screenshot` RPC commits | `age_days: int`, `was_assigned: bool`, `had_revisits: bool` | Capture quality signal (fast deletes = noise captures) |

### Digest & onboarding

| Event | Platform | Trigger point | Properties | Consumed by |
|---|---|---|---|---|
| `digest_generated` | server | Weekly digest cron completes for the user | `screenshot_count: int`, `thread_count: int`, `duration_ms: int` | Digest pipeline health |
| `digest_viewed` | web | Digest page/panel opened | `age_hours: int` (generated→viewed) | Digest engagement rate |
| `onboarding_completed` | mac | First suggestion interaction done in first-run flow (user_flows.md F9) | `duration_ms: int` (install→done), `permission_granted: bool`, `hotkey_rebound: bool` | Activation rate; time-to-first-capture |

## Example payload

`capture_completed` as sent to PostHog:

```json
{
  "event": "capture_completed",
  "distinct_id": "9a1c7c2e-…",
  "properties": {
    "user_id": "9a1c7c2e-…",
    "platform": "mac",
    "app_version": "0.3.1",
    "session_id": "4f0b…",
    "source": "hotkey_region",
    "duration_ms": 2140,
    "annotated": false,
    "bytes": 1832400,
    "width": 2412,
    "height": 1548
  }
}
```

## Instrumentation notes

- Client events buffer offline and flush on reconnect (PostHog default); server events are fire-and-forget with a 1s timeout — analytics failures must never fail the request path.
- `thread_id_hash` / `query_hash`: SHA-256 truncated to 16 hex chars, salted with `user_id` — allows per-entity aggregation without leaking names.
- Auto-assign acceptance is computed, not emitted: `ai_suggestion_shown[mode=auto_assign]` minus subsequent `ai_suggestion_corrected` within 24h.
- Event name changes require updating this file first; PostHog dashboards reference these names verbatim.
