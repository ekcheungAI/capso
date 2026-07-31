# 14 — Backend & Storage

> Capso (working name — unconfirmed). Buckets, the jobs pipeline, embeddings, chat memory, quotas, deletion, backups.
> Siblings: `09_AI_SYSTEM_AND_MODEL_ROUTING.md` (which model runs per job), `10_DATA_MODEL.md` (tables referenced here), `11_ARCHITECTURE.md` (why jobs table + pg_cron).

## Assumptions

- Supabase cloud project, single region; one owner-user in MVP but all layouts keyed by `user_id` (SaaS-ready).
- Volumes: ≤ ~1,000 captures/month, avg original PNG ~1.5 MB retina → ≤ ~18 GB/year worst case. Well inside one Supabase project.
- Edge Function invocation limits per `11_ARCHITECTURE.md` §6 (verify at build time).

## Out of scope

- CDN/image-optimization service beyond Supabase Storage's built-in transform/CDN.
- Full-account export/delete flows (post-MVP; schema must not block — see §7).
- Link/PDF asset storage (bucket names reserved conceptually, nothing built).

## 1. Storage layout (requirement)

Two private buckets:

| Bucket | Content | Naming | Access |
|--------|---------|--------|--------|
| `originals` | Full-resolution PNG as captured | `user_id/screenshot_id.png` | Private; clients read via short-lived signed URLs; AI worker passes a signed URL to the vision provider |
| `thumbs` | WebP, 800 px longest edge, quality ~80 | `user_id/screenshot_id.webp` | Private; signed URLs; used by web grid, overlay, chat citations |

- Thumb is generated **client-side in the Mac app** at capture time (canvas/`image` crate) and uploaded alongside the original — no server-side image processing service in MVP. If the thumb upload fails, web falls back to a Storage transform of the original.
- Storage RLS policies mirror DB RLS: path must start with `auth.uid()`.
- The image sent to W1 is a downscaled variant (longest edge ~1568 px) to control image tokens (09 §1 cost target). Use the thumb when 800 px suffices for legibility; else a transform of the original. Decide by OCR quality during build; token cost is the tiebreaker.

## 2. Jobs table (requirement)

Specced here (referenced by `10_DATA_MODEL.md`):

```sql
CREATE TYPE job_status AS ENUM ('pending','processing','done','failed');
CREATE TABLE jobs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL,          -- 'process_capture' | 'embed' | 'digest' | 'resummarize_thread'
  payload      jsonb NOT NULL,         -- e.g. {screenshot_id}
  status       job_status NOT NULL DEFAULT 'pending',
  attempts     int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3,
  run_after    timestamptz NOT NULL DEFAULT now(),  -- backoff scheduling
  locked_at    timestamptz, locked_by text,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON jobs (status, run_after) WHERE status IN ('pending','processing');
```

## 3. Processing pipeline (requirement)

States: `pending → processing → done | failed`.

1. **Enqueue:** Mac app inserts `screenshots` row + `jobs(kind='process_capture')` in one RPC; optionally "kicks" the worker directly (11 §3) — pg_cron every 15s is the sweeper of record.
2. **Dequeue:** worker Edge Function claims one job atomically: `UPDATE … SET status='processing', locked_at=now(), attempts=attempts+1 WHERE id = (SELECT id FROM jobs WHERE status='pending' AND run_after <= now() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`. One job per invocation (timeout safety, 11 §6).
3. **Work:** assemble few-shot corrections (W7) + thread candidates → one Haiku-class call (W1) → embed (W2) → write results + `classification_suggestions` row → auto-assign if confidence ≥ 0.8 → `done`.
4. **Failure:** set `status='pending'`, `run_after = now() + (10s, 60s by attempt)`, record `last_error`. On `attempts >= max_attempts (3)` → `failed`, `screenshots.processing_status='unprocessed'` (badge + date-only search, 09 §6).
5. **Idempotency (requirement):** workers must be safe to re-run — result writes are `UPDATE … WHERE id=` upserts keyed on `screenshot_id`; a job whose screenshot is already `processed` short-circuits to `done`. Stale `processing` rows (locked_at > 10 min) are reset to `pending` by a pg_cron janitor.
6. **Circuit breaker:** ≥3 consecutive provider failures → pause dequeue 15 min (09 §6). Queue holds; nothing dropped.

## 4. OCR / classification result storage & embedding pipeline (requirement)

- W1 JSON lands as columns on `screenshots` (`ocr_text, summary, type, intent, why_saved`) — decision + justification in `10_DATA_MODEL.md`. Full raw JSON kept in `classification_suggestions.raw_response` for audit/re-processing.
- **What gets embedded:** one string per capture — `summary + "\n" + first 1,500 chars of ocr_text + "\n" + intent`. Summary leads because it's the highest-signal retrieval text; raw OCR tails are noisy.
- **Model/dimension:** open provider decision (09 §8); dimension fixed at **1536** in the `vector(1536)` column.
- **When re-embedded:** (a) manual "Retry AI" on unprocessed items; (b) provider swap → backfill job iterates `screenshots` in batches of 100, re-embeds, and rebuilds the HNSW index — a `jobs(kind='embed')` fan-out, not a migration script; (c) never on thread reassignment (embedding is content-derived, not thread-derived).
- Embedding failure after W1 success degrades gracefully: keyword search (tsvector) works immediately; a separate `embed` job catches up (09 §6).

## 5. Chat memory storage (requirement)

- Every turn appends to `conversation_messages` (10). Context for a W4 call = `project_threads.rolling_summary` + last 20 messages + W5 tool results.
- **Rolling summary:** after every **N = 30** new messages in a thread (`rolling_summary_msg_count`), enqueue `jobs(kind='resummarize_thread')`; a Haiku-class call compresses summary+overflow into a fresh `rolling_summary` (~300 tokens), reset counter. Cheap tier on purpose — summarization is not a user-facing answer.
- OCR text inside retrieved captures stays wrapped as untrusted data blocks in chat context (09 §9).

## 6. Cost-sensitive queuing (requirement)

- **Serial per user:** worker claims at most one job per user at a time (claim query filters `user_id NOT IN (SELECT user_id FROM jobs WHERE status='processing')`). Prevents a paste-burst of 30 screenshots from firing 30 concurrent vision calls.
- **Batch embeddings:** when >5 embed-only jobs are queued for a user, the worker coalesces them into one provider batch call (embedding APIs accept arrays). W1 vision calls are never batched (latency target for the overlay).
- **Rate limits:** config caps — max 10 W1 calls/min/user, max 60 chat turns/hour/user. Exceeding = jobs wait (queue holds), chat returns a friendly "slow down" error. Values in config, not code.
- Provider 429s are treated as retryable failures with the standard backoff, plus circuit breaker (§3.6).

## 7. Data retention, privacy & deletion (requirement)

- **Originals kept indefinitely in MVP.** No auto-expiry; the product is memory.
- **Quota accounting:** `users.storage_bytes_used` incremented on upload, decremented on delete (RPC does both row + counter). Not enforced in MVP; becomes the free-tier storage gate later (`billing_plans.storage_gb`).
- **Delete screenshot = hard delete everything:** one RPC/Edge Function deletes the `screenshots` row (cascades per 10: events, suggestions, corrections, revisits; embedding dies with the row) **and** removes `originals/user_id/id.png` + `thumbs/user_id/id.webp`. Storage delete failures are enqueued as a cleanup job so orphaned files can't linger silently.
- **Providers see images transiently** (locked decision): images go out only as short-lived signed URLs at inference time; no provider-side storage/training opt-ins; verify provider data-retention settings at build time.
- **Full-account export/delete: post-MVP**, but unblocked by design — every row hangs off `user_id`, every file path starts with `user_id/`, so export = per-table dump + bucket prefix copy, delete = auth cascade + prefix purge.
- Never ingest `.env*`, secrets, tokens into the repo or DB seed data (house rule).

## 8. Backup posture (requirement)

- Supabase **PITR** (point-in-time recovery) enabled if the plan tier allows; otherwise daily automated backups (default) — accept up to 24h RPO for MVP and note it.
- Storage buckets are not covered by DB backups: rely on Supabase's storage durability for MVP; post-MVP idea — weekly `rclone` sync of both buckets to a second object store.
- Restore drill (one-time task before calling MVP done): restore backup to a scratch project, confirm a screenshot row + file pair round-trips.

## 9. Ideas (not requirements)

- `pg_partman` partitioning of `capture_events`/`retrieval_queries` if telemetry volume grows.
- Perceptual-hash column on `screenshots` for duplicate-capture detection ("you saved this already").
- Storage lifecycle rule moving originals older than 1 year to cheaper storage once tiers exist.
