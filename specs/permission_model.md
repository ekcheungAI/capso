# Capso — Permission & Privacy Model (v1)

Covers macOS permissions, data-access model (RLS + Storage), AI provider data handling, user privacy controls, build-time secrets, and threat notes. Data model in ../10_DATA_MODEL.md; API surface in api_contracts.md; failure behavior in edge_cases.md.

## Assumptions

- Single-user MVP on the owner's Supabase project, but **every policy is written multi-tenant-safe** so SaaS later requires zero schema/policy rewrites.
- Mac app is notarized and sandboxed-off (global hotkeys + `screencapture` require it to run outside App Store sandbox); distribution is direct download.

## Out of scope

- Team/sharing permissions, SSO, admin roles, compliance certifications (SOC2 etc.), mobile.

## 1. macOS permissions

| Permission | Needed? | Why | When prompted | Without it |
|---|---|---|---|---|
| Screen Recording | Yes (core) | `screencapture -iw` window capture and reliable full-fidelity capture of other apps' windows | Onboarding step 3 (user_flows.md F9) with an explainer screen before the OS prompt; deep link to System Settings pane | Degraded mode: interactive **region** capture (`screencapture -i`) may still work since it is user-driven selection, but **window capture (⌃⇧W) will not** — it returns blank/wallpaper-only content. App detects preflight failure, disables ⌃⇧W, and shows a persistent "grant permission" affordance. Never silently produce blank captures (edge_cases.md §1). |
| Notifications | Optional | Sync-failure and "processing done" notices | Offered (not forced) during onboarding step 4; skippable | Overlay + menu-bar badges carry all critical states; nothing breaks |
| Login Item | Optional | Menu-bar app auto-start so hotkeys always work | Onboarding toggle via `SMAppService`; user-visible in System Settings > Login Items | User must launch manually; note shown if hotkey pressed while app not running is impossible to catch — docs only |
| Accessibility | **No** | Not needed: no synthetic input, no window-content reading via AX APIs in MVP | Never | — |
| Full Disk Access / Files | No | Captures go to app-controlled temp + Application Support only | Never | — |

Rules: never request a permission before the screen that explains it; re-prompt at most once per session when the user invokes a feature that needs it; permission state re-checked on every app focus (users revoke in System Settings).

## 2. App data-access model (Supabase)

**Postgres RLS** — enabled on every table; no table readable without a policy. Canonical policy shape (applies to `screenshots`, `projects`, `chat_messages`, `user_corrections`, `revisits`, `user_settings`, `jobs`):

```sql
create policy "owner_all" on screenshots
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

- Write-restricted tables (per api_contracts.md §1): client-side insert on `screenshots`/`chat_messages`/`user_corrections` is denied by omitting those grants — writes go through Edge Functions running with service role, which still stamp `user_id` from the verified JWT, never from request bodies.
- `service_role` key exists **only** inside Edge Functions env; never shipped to clients.

**Storage bucket policies** — buckets `originals` and `thumbs` are **private** (public = false, non-negotiable; see §7). Path convention `{bucket}/{user_id}/{screenshot_id}.{ext}` and policies enforce path ownership:

```sql
create policy "read_own" on storage.objects for select
  using (bucket_id in ('originals','thumbs')
         and (storage.foldername(name))[1] = auth.uid()::text);
create policy "upload_own" on storage.objects for insert
  with check (bucket_id = 'originals'
              and (storage.foldername(name))[1] = auth.uid()::text);
```

Clients render images via `createSignedUrl` with **60s expiry** (detail view) / 10 min (grid batch); no public URLs anywhere. `thumbs/` is written only by the server-side thumbnail step.

## 3. AI provider data handling

- Per ../09_AI_SYSTEM_AND_MODEL_ROUTING.md: one Haiku-class vision call per capture (image + prompt), Sonnet-class for chat/digest (OCR text + summaries, images only when explicitly attached).
- Images and OCR text are sent **transiently for processing only** — Capso stores results in its own DB; the provider must not be used as storage.
- Provider selection requirement: **only providers/plans with a contractual no-training-on-API-data policy** (e.g. Anthropic API, OpenAI API with training opt-out enforced). Consumer-tier endpoints that train on inputs are banned.
- **Per-provider retention setting to verify before launch (open checklist):** ☐ confirm the chosen provider's API data-retention window (e.g. abuse-monitoring retention of ~30 days vs zero-data-retention option), ☐ enable ZDR/shortest retention where offered, ☐ record the verified setting + date in this file when done.
- Prompt-injection posture for model calls: screenshot-derived text is delimited untrusted data; chat model's only tool is read-only `search_memory` (edge_cases.md §6).

## 4. User privacy controls (MVP)

| Control | Behavior |
|---|---|
| Delete screenshot | **Hard delete everywhere**: DB row, embedding vector, revisits, corrections, both storage objects; chat references nulled to placeholders. One transaction via `delete_screenshot` RPC (api_contracts.md §7, user_flows.md F10). No soft-delete, no trash, no backup resurrection promise beyond Supabase PITR window — documented to the user in the confirm dialog. |
| Pause AI processing | Settings toggle (`user_settings.ai_paused`). Captures still save + upload; ingest enqueues jobs as `held` (not picked up by worker). Unpausing releases held jobs FIFO. Overlay shows "Saved (AI paused)" instead of a suggestion chip. |
| Local redaction | Blur annotation tool (user_flows.md F7) destructively removes pixels **before** upload — the only pre-cloud redaction path in MVP; onboarding tip mentions it for sensitive captures. |

## 5. Post-MVP controls (documented now, not built)

- **Sensitive-exclude toggle per capture**: overlay button "don't process with AI" → stores image, skips vision/embedding permanently.
- **App blocklist**: never allow capture overlay/processing when frontmost app is on the list (password managers, banking apps preloaded).
- **Local-only mode**: captures stay on-device, no upload, no AI; search limited to on-device metadata.
- **Full export**: one-click ZIP of originals + JSONL of metadata/OCR/threads/chats.

## 6. Secrets handling (building Capso itself — ekOS rules apply)

- All secrets in `.env.local` / environment variables; **never committed to git** (repo-level rule, see ~/Desktop/ekOS/CLAUDE.md 發佈安全).
- Client-side (Tauri + Next.js public env): Supabase URL + anon/publishable key only — safe because RLS is the enforcement boundary.
- Server-side only (Edge Function secrets via `supabase secrets set`): `service_role` key, AI provider API keys, PostHog server key, Sentry DSN (DSN may be client-side; auth tokens may not).
- No secrets in Tauri config, in analytics properties (event_schema.md PII rule), or in Sentry breadcrumbs (scrub `Authorization` headers and storage paths in beforeSend).
- CI/Vercel: env vars via dashboard, never in `vercel.json`.

## 7. Threat notes

| Threat | Mitigation |
|---|---|
| **Screenshots routinely contain tokens, API keys, passwords, financial data** — the product's corpus is inherently sensitive | Buckets never public (config-reviewed at every deploy); signed URLs short-lived (60s detail / 10min grid); no image URLs in logs, analytics, or Sentry; blur tool for pre-upload redaction; post-MVP blocklist + sensitive-exclude reduce collection |
| Stolen anon key | Anon key grants nothing without a valid user JWT thanks to RLS + private buckets; auth restricted to owner's email in MVP (Supabase auth allowlist) |
| Leaked signed URL (pasted, logged upstream) | Short expiry bounds exposure window; URLs never sent to third parties |
| Prompt injection via OCR content steering the assistant | Untrusted-data delimitation + read-only tool surface; assistant instructed to treat in-image instructions as data (edge_cases.md §6) |
| AI provider breach/retention | No-training providers only; shortest retention setting; only per-capture image + text sent, never bulk corpus |
| Local machine access | Local queue lives in Application Support (protected by macOS user account + FileVault); auth tokens in Keychain, not plist |
| Supabase project compromise (worst case) | Single-tenant blast radius in MVP; service key confined to Edge Functions; enable 2FA on Supabase account; PITR on |

## 8. Pre-launch verification checklist

- [ ] `select * from pg_policies` shows an owner policy on every app table; no table with RLS disabled.
- [ ] Buckets `originals` and `thumbs` report `public = false`; unauthenticated GET on a known object path returns 400/403.
- [ ] Signed URL for user A's object rejected when requested with user B's JWT (test with a second throwaway auth user even in single-user MVP).
- [ ] Anon key + no JWT: every table select returns zero rows; every Edge Function returns 401.
- [ ] `screencapture` degraded mode manually tested with Screen Recording revoked: ⌃⇧W blocked with prompt, no blank images saved.
- [ ] `delete_screenshot` leaves zero rows across all tables and zero storage objects (verify with service-role query after test delete).
- [ ] AI provider retention setting verified and recorded in §3 with date.
- [ ] Grep release build for `service_role` and provider API keys: zero hits in client bundles.
- [ ] Sentry beforeSend scrubs Authorization headers and storage paths (send a test event, inspect).
- [ ] PostHog live events inspected for one full capture→chat cycle: no OCR text, names, or query text present (event_schema.md PII rule).

Review cadence: re-audit this file when adding any new capture kind, provider, or the first non-owner user.
