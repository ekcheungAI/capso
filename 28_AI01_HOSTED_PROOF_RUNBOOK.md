# 28 — AI-01 Hosted Proof Runbook

> Proves gate **AI-01** from `27_CLEANSHOT_DAILY_DRIVER_PARITY.md`: background OCR,
> classification, and project routing complete **with every Capso browser tab closed**.
> This is the single biggest open risk on the path to cancelling CleanShot for daily
> screenshots, so it is the first gate to clear.

## What is already verified (2026-08-11, hosted project `xbxedriuelwqjypdkvex`)

- All 11 migrations applied; the `jobs` table, `ingest_native_capture` RPC, RLS
  hardening, and pg_cron wake are live.
- Edge function `v1-process-screenshot` is deployed and ACTIVE.
- The `capso-process-screenshot` cron job is active on a `* * * * *` (once-per-minute)
  schedule, and the `capso_worker_secret` Vault secret is present.
- `jobs` and `screenshots` are empty — **no real capture has flowed through yet.**
  That empty state is precisely what this runbook closes.

## Prerequisite — rotate the exposed credential first

Loops 48 and 50 recorded that a Supabase secret/password was pasted during
development. **Rotate it before trusting the pipeline** (this is your action; the
agent does not handle credentials):

1. Supabase dashboard → project `xbxedriuelwqjypdkvex` → Settings → API/Database:
   rotate the service-role key and the database password.
2. Update the `capso_worker_secret` Vault entry if the worker secret changed.
3. Update `apps/web/.env.local` and the Vercel deployment env with the new values.
4. Redeploy the web app and re-run the Edge function deploy if the secret rotated.

## The proof — one capture, browser closed

You need a signed-in mac app and the same account on the deployed web app.

1. **Sign in on the web app.** Open the deployed site, request the magic-link email,
   and complete sign-in. Note the account email.
2. **Sign in on the mac app.** Run a debug build (`pnpm --filter mac tauri dev`, or a
   built `.app`), open the menu-bar popover, and complete native email sign-in with the
   **same** email. The native PKCE handoff (`apps/mac/src-tauri/src/auth.rs`) stores the
   session in Keychain.
3. **Start the watcher** in a terminal (get the service-role key from the dashboard):

   ```bash
   CAPSO_SERVICE_ROLE_KEY=<service_role_key> pnpm verify:ai01
   ```

   Optional: `CAPSO_USER_ID=<your-uuid>` to watch only your captures,
   `CAPSO_TIMEOUT_SECONDS=300` for a longer window.
4. **Close every Capso browser tab.** No Capso tab open anywhere.
5. **Take one region capture** in the mac app and leave the browser closed.
6. Watch the terminal. It will report: capture ingested → job processing → processed,
   with the classification result and the ingest→processed latency.

## Pass / fail

- **PASS** (exit 0): the new `screenshots` row reaches `processing_status = 'processed'`
  with non-empty `ocr_text`, `intent`, and `search_text`, `simulated = false`, and
  latency within the `<8s` p90 ceiling — all with the browser closed. Record the run as
  AI-01 evidence in `loops/STATE.md` (flip the gate to PASS) and `BUILD_LOG.md`.
- **FAIL / TIMEOUT** (exit 1): the watcher names the stage that stalled and the likely
  cause — not signed in (never ingested), cron/Vault/Edge misconfig (ingested but never
  claimed), or a terminal worker error (check the `v1-process-screenshot` function logs
  in the Supabase dashboard).

## What this gate does and does not authorize

Passing AI-01 proves background processing works browser-closed. It does **not** on its
own authorize cancelling CleanShot — that requires every other gate in
`27_CLEANSHOT_DAILY_DRIVER_PARITY.md` plus the five-day dogfood (DOG-01). Next after
this: the physical-QA gates (CAP-02b latency run, UX-01, OVL-01, ANN-01, DUR-01b offline
drill, HIS-01).
