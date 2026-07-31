# Capso — API Contracts (v1)

Boundary rule: **default to Supabase client SDK + RLS for CRUD; custom Edge Functions only where server-side logic is required** (ingest finalization, AI calls, retrieval ranking, correction bookkeeping). Tables per ../10_DATA_MODEL.md; RLS policies per permission_model.md.

## Assumptions

- All Edge Functions live under the version prefix `/v1` (`https://<project>.supabase.co/functions/v1/...` — the literal function names carry the `v1-` route segment shown below as `/v1/*`).
- Clients: Tauri Mac app and Next.js web app, both holding a Supabase Auth session.
- Single user (owner) in MVP, but every contract is multi-tenant-safe via `user_id` from the JWT — never from the request body.

## Out of scope

- Billing endpoints, public/share links, webhooks, mobile push. Rate limits are idea-level only (documented, not necessarily enforced day one).

## 1. Direct Supabase SDK access (RLS-guarded)

Clients read/write these tables directly; RLS restricts every row to `auth.uid() = user_id`:

| Table | Client operations | Notes |
|---|---|---|
| `screenshots` | select, update (`project_id`, `title`), no insert/delete | Insert only via `/v1/ingest`; delete only via `delete_screenshot` RPC |
| `projects` (threads) | select, insert, update (title, description, `archived_at`), delete | Delete moves member screenshots to Inbox (trigger), see edge_cases.md §5 |
| `chat_messages` | select only | Writes happen server-side in `/v1/chat` |
| `user_corrections` | select only | Writes via `/v1/suggestion/respond` or assignment triggers |
| `revisits` | insert, select | Client logs detail-view opens |
| `user_settings` | select, update | Hotkeys, pause-AI toggle, onboarding flag |
| `jobs` | select only (status polling fallback) | Primary signal is Realtime on `screenshots.status` |
| Storage `originals/`, `thumbs/` | upload (originals only), createSignedUrl | Path convention `{bucket}/{user_id}/{screenshot_id}.{ext}`; policies in permission_model.md |

Realtime subscriptions: `screenshots` (status/suggestion updates for overlay + web badges), `chat_messages` (cross-device sync).

## 2. Conventions

**Auth header** — every Edge Function call: `Authorization: Bearer <supabase_access_token>` (+ `apikey: <anon_key>`). Function verifies JWT; `user_id` always derived server-side.

**Error envelope** — non-2xx bodies are always:

```json
{ "error": { "code": "thread_not_found", "message": "Thread b1f4… does not exist", "retryable": false } }
```

Codes: `unauthorized` (401), `not_found` / `thread_not_found` / `screenshot_not_found` (404), `invalid_request` (400, includes field errors in `message`), `conflict` (409), `rate_limited` (429), `provider_unavailable` (503, `retryable: true`), `internal` (500).

**Rate-limit headers** (idea-level, per user): `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (unix seconds). Suggested budgets: ingest 60/min, chat 20/min, search 60/min. 429 uses the error envelope + `Retry-After`.

## 3. POST /v1/ingest — finalize an upload

Called after the client has verified the Storage upload. Idempotent on `content_hash` within the dedupe window (edge_cases.md §3).

Request:

```json
{
  "storage_path": "originals/9a1c…/f3d2c8a0-….png",
  "captured_at": "2026-07-31T09:14:02+08:00",
  "source": "hotkey_region",
  "content_hash": "sha256:8c1e…",
  "annotated": false,
  "width": 2412, "height": 1548, "bytes": 1832400
}
```

`source` ∈ `hotkey_region | hotkey_window | drag | clipboard | web_upload`. (`capture_kind` is implicitly `screenshot` in v1; field reserved per ../04_MVP_SCOPE.md.)

Response `201`:

```json
{ "screenshot_id": "f3d2c8a0-…", "status": "processing", "deduped": false }
```

Dedupe hit returns `200` with the existing id and `"deduped": true`. Side effects: inserts `screenshots` row (status `processing`), enqueues `process-screenshot` job, generates thumb (async), fires server-side `upload_succeeded`.

Errors: `invalid_request` (bad path/hash), `not_found` (storage object missing), `conflict` (path already ingested to a different id).

## 4. POST /v1/chat — thread chat (SSE)

Request:

```json
{
  "thread_id": "b1f4…",
  "message": "what onboarding patterns did I save last month?",
  "screenshot_ids": ["f3d2c8a0-…"]
}
```

`screenshot_ids` optional — explicit attachments (F3 in user_flows.md). Server assembles context per ../07_FEATURE_SPEC_PROJECT_THREADS.md (thread metadata, recent turns, attachments' summary+OCR as **delimited untrusted data** — edge_cases.md §6) and calls the Sonnet-class model with one tool:

```json
{
  "name": "search_memory",
  "description": "Search the user's saved screenshots.",
  "input_schema": { "type": "object", "properties": {
    "query": { "type": "string" },
    "project_id": { "type": "string", "description": "omit to search all projects" },
    "intent": { "enum": ["design_inspiration","ux_bug","competitor","marketing_hook","content_idea","reference","other"] },
    "date_from": { "type": "string", "format": "date" },
    "date_to": { "type": "string", "format": "date" },
    "limit": { "type": "integer", "default": 8, "maximum": 20 }
  }, "required": ["query"] }
}
```

Response: `text/event-stream`.

```
event: message_start   data: {"message_id":"m_01…"}
event: text_delta      data: {"text":"Last month you saved three onboarding flows…"}
event: reference       data: {"screenshot_id":"a77e…","summary":"Linear onboarding checklist","thumb_path":"thumbs/…"}
event: tool_activity   data: {"tool":"search_memory","status":"done","result_count":3}
event: done            data: {"message_id":"m_01…","referenced_screenshot_ids":["a77e…"],"stop_reason":"end_turn"}
```

Side effects: persists user + assistant `chat_messages`, fires `chat_screenshot_referenced` per surfaced screenshot. Errors before stream start use the envelope; mid-stream failure emits `event: error` with the same envelope shape then closes.

## 5. GET /v1/search — natural-language retrieval

`GET /v1/search?q=dark+pricing+page+countdown&project_id=&intent=competitor&date_from=2026-06-01&limit=20`

All filters optional except `q`. Server embeds the query, runs hybrid ranking (pgvector cosine on embedding + keyword match on `ocr_text`/`summary`, recency boost).

Response `200`:

```json
{
  "results": [
    {
      "screenshot_id": "a77e…",
      "score": 0.87,
      "summary": "Competitor pricing page, dark theme, launch countdown",
      "thumb_path": "thumbs/9a1c…/a77e….webp",
      "project": { "id": "b1f4…", "title": "Competitor research" },
      "captured_at": "2026-07-12T18:03:00Z",
      "intent": "competitor",
      "match_reasons": ["ocr: \"countdown\"", "semantic: pricing page layout", "intent filter"]
    }
  ],
  "total": 14, "query_id": "q_5c…"
}
```

`query_id` links `search_performed` → `search_result_clicked` (client echoes it in the click event). Empty result set is `200` with `results: []` — never an error.

## 6. POST /v1/suggestion/respond — accept / correct / ignore

Request:

```json
{ "screenshot_id": "f3d2c8a0-…", "action": "correct", "chosen_project_id": "c9aa…" }
```

- `accept` → sets `project_id` to the suggestion, `assignment_source: suggestion_accepted`.
- `correct` → requires `chosen_project_id` (or `new_thread_title` to create-and-assign); writes a `user_corrections` row `{screenshot_id, suggested_project_id, chosen_project_id, ocr_excerpt, created_at}` used as few-shot context (../09_AI_SYSTEM_AND_MODEL_ROUTING.md).
- `ignore` → leaves unassigned, status `inbox`.

Response `200`: `{ "screenshot_id": "…", "project_id": "c9aa…", "assignment_source": "user_corrected" }`. Errors: `thread_not_found` (409/404 per edge_cases.md §4), `invalid_request` (correct without target), `conflict` (already responded — response is idempotent for the same action, conflicting action wins-last with correction logged).

Fires the matching analytics event server-side (`ai_suggestion_accepted|corrected|ignored`).

## 7. RPC delete_screenshot(screenshot_id)

Postgres function, invoked via SDK `rpc()`. Single transaction: deletes screenshot row + embedding + revisits + corrections, nulls chat references, then removes both storage objects (via function-owned service role). Returns `{ "deleted": true }`. See user_flows.md F10 and permission_model.md privacy guarantees.

## 8. Internal worker contract — process-screenshot

Queue: `jobs` table drained by pg_cron-triggered Edge Function worker. **Idempotency key = `screenshot_id`** (unique partial index on active jobs; re-enqueue of a done screenshot is a no-op).

Payload (jobs.payload):

```json
{ "screenshot_id": "f3d2c8a0-…", "storage_path": "originals/…", "attempt": 1 }
```

Worker steps: fetch image (signed URL) → one Haiku-class vision call → validate against schema below (one schema-retry on parse failure, then `unprocessed`; edge_cases.md §2) → one embedding call on `summary + ocr_text` → write results + apply confidence routing (≥0.8 auto-assign to existing thread only / 0.5–0.8 suggest / <0.5 inbox) → job `done`, fire `ai_processing_completed`.

Result written to `screenshots`:

```json
{
  "ocr_text": "…verbatim, original language…",
  "summary": "Competitor pricing page with launch countdown",
  "type": "screenshot",
  "intent": "competitor",
  "project_suggestion": { "project_id": "b1f4…", "name": "Competitor research" },
  "confidence": 0.64,
  "why_saved": "Pricing layout likely relevant to teardown work"
}
```

Failure: attempt++ with backoff (5s/30s/2m); after 3 → `failed`, screenshot flagged `unprocessed`, Sentry alert. Provider-outage circuit breaker holds jobs `pending` without consuming attempts (edge_cases.md §2).
