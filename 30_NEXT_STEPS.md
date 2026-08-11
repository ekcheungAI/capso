# 30 — Next Steps: Your Step-by-Step Run Order

> The short version: everything that can be verified from code is now verified. The
> remaining gates need your hands. This is the exact order to walk them, and what to
> report back so the next build round is grounded in real results instead of guesses.

## What is already verified (you do not need to re-check these)

| Thing | State | How it was verified |
|---|---|---|
| Hosted migrations (all 11) | applied | Supabase management API |
| Edge worker `v1-process-screenshot` | deployed, ACTIVE | Supabase management API |
| pg_cron `capso-process-screenshot` | active, `* * * * *` | queried `cron.job` |
| Vault `capso_worker_secret` | present | queried `vault.decrypted_secrets` |
| Deployed web app | live, sign-in gate renders, no console errors | loaded the real site |
| `/auth/open-capso` handoff route | deployed; rejects malformed calls (400, not 404) | fetched on the deployed origin |
| Mac app | compiles clean, **and** compiles with cloud config | `cargo build` both ways |
| `jobs` + `screenshots` tables | **empty** | queried — this is the AI-01 gap |

**The one blocker found and fixed:** the Mac app reads its Supabase config at *compile
time* (`apps/mac/src-tauri/build.rs`), and does **not** read `.env.local`. Building with a
plain `pnpm --filter mac tauri dev` yields an app that silently cannot sign in or sync.
Use `scripts/mac-cloud.sh` instead (below) — it passes the right values through.

---

## Step 0 — Rotate the exposed Supabase credential (do this first)

Loops 48/50 recorded a pasted secret. Until it is rotated, do not treat the hosted
pipeline as trustworthy. In the Supabase dashboard for project `xbxedriuelwqjypdkvex`:

1. Settings → API: rotate the **service_role** key.
2. Settings → Database: rotate the **database password**.
3. If the worker secret changed, update the `capso_worker_secret` Vault entry.
4. Update `apps/web/.env.local` and the Vercel environment, then redeploy.

Public values (the `sb_publishable_` key and project URL) do **not** need rotating —
they are meant to live in client binaries.

## Step 1 — Allowlist the native callback (2 minutes, dashboard)

The Mac app completes sign-in by handing off to `capso://auth/callback`. If that scheme
is not allowlisted, sign-in fails at the last step.

- Supabase dashboard → Authentication → URL Configuration.
- **Site URL**: `https://capso-cyan.vercel.app`
- **Redirect URLs** must include: `capso://auth/callback` and
  `https://capso-cyan.vercel.app/**`

This is the last piece of AI-01 I could not verify from here — it is dashboard-only config.

## Step 2 — Run the Mac app with cloud enabled

```bash
scripts/mac-cloud.sh dev
```

It prints the cloud config it compiled in. If it errors, it tells you which value is
missing. (`scripts/mac-cloud.sh build` produces a debug `.app` bundle instead.)

## Step 3 — Sign in on both sides with the same email

1. Open `https://capso-cyan.vercel.app`, enter your email, complete the magic link.
2. In the Mac menu-bar popover, sign in with the **same** email and complete the handoff.

Both must show a signed-in account before the proof will work.

## Step 4 — Run the AI-01 proof

```bash
CAPSO_SERVICE_ROLE_KEY=<new_service_role_key> pnpm verify:ai01
```

Then: **close every Capso browser tab**, take **one region capture** (⌃⇧C), and leave the
browser closed. The watcher reports ingest → processing → processed with the
classification result and latency.

## Step 5 — Work the physical QA checklist

Open `29_PHYSICAL_QA_CHECKLIST.md` and walk it in one sitting. The headline item is the
20-capture latency run: take 20 real captures, then read **"Overlay Speed Check"** in the
tray — it must say **PASS**.

---

## What to report back to me

Paste these and I can pick the next work with a real picture:

1. **The full terminal output of `pnpm verify:ai01`** — pass or fail. If it fails, it
   names the stage that stalled; that tells me exactly where to dig.
2. **The "Overlay Speed Check" readout** (e.g. `PASS` or `19/20`).
3. **Any checklist item that failed**, with what you saw.
4. **Decisions I cannot make for you:**
   - The permanent bundle identifier to replace `com.capso.app` (e.g. `com.ekcheung.capso`).
   - Whether you want to enrol in the Apple Developer Program (~US$99/yr) now — required
     for PKG-01 signing/notarization, and unavoidable for a Gatekeeper-clean install.
   - Is `design-qa.md` (untracked, repo root) a deliverable to keep, or scratch to delete?

## What I will build next, depending on your results

- **If AI-01 passes** → flip the gate in `loops/STATE.md`, then build the retrieval
  (RET-01, pgvector + keyword hybrid) and learning (LRN-01, three-corrections eval)
  implementations. These need the real classified-data shape, which is why they are not
  built yet.
- **If AI-01 fails** → I debug the named stage (worker logs, cron delivery, or the
  auth/session path) before anything else moves.
- **Once you choose a bundle id** → I wire the identity and the signing/notarization
  config so PKG-01 only needs your certificate.

## Reality check on "replacing CleanShot"

Clearing every gate here earns "stop using CleanShot for daily screenshots" — not
"uninstall it". Scrolling capture, screen/GIF recording, OCR text-copy, and public share
links are explicitly out of the current scope and remain in CleanShot's favour. When you
want those, the route is the black-box study in `27_…PARITY.md` §Reference and clean-room
boundary: observe behaviour as a user, implement independently, never decompile or copy
its code or assets.
