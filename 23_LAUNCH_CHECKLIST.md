# 23 — Launch Checklist: First External Tester Gate

> **Scope: this gates the FIRST EXTERNAL TESTER, not a public launch.** Free beta — billing is explicitly NOT required (locked decision #6). Every box below must be checked before a single non-owner account exists. Cross-refs: `16_PRICING_AND_PACKAGING.md`, `17_METRICS_AND_ANALYTICS.md`, `18_RISKS_AND_OPEN_QUESTIONS.md`.
>
> Name "Capso" unconfirmed — resolve Q1 in `18_RISKS_AND_OPEN_QUESTIONS.md` before anything tester-facing carries the name.

## 0. Personal dogfood exit criteria — HARD GATE, before everything else

No tester work starts until ALL of these are true (evidence from PostHog dashboards in `17_METRICS_AND_ANALYTICS.md`):

- [ ] Owner has **cancelled the CleanShot X subscription** (not just stopped using it)
- [ ] **≥ 2 weeks of daily use** (≥ 1 `capture_completed` on ≥ 12 of last 14 days)
- [ ] **Suggestion acceptance rate ≥ 60%** (accepted / (accepted + corrected + ignored), trailing 2 weeks)
- [ ] **≥ 1 successful "found an old screenshot via search" moment per week**, both weeks (target screenshot > 7 days old)
- [ ] Weekly review notes confirm no R2 tripwire (no reaching for CleanShot) — see `18_RISKS_AND_OPEN_QUESTIONS.md`

## 1. Onboarding & first-run

- [ ] Onboarding flow complete: install → sign in → macOS screen-recording permission → hotkey setup → first capture
- [ ] **Tested on a clean Mac** (fresh macOS user account or spare machine — no dev leftovers, no pre-granted TCC permissions)
- [ ] First-run tutorial exists: **3-step overlay** (1. hotkey to capture → 2. confirm the AI suggestion → 3. search/ask to retrieve)
- [ ] `onboarding_completed` fires at the correct moment and is visible in PostHog
- [ ] Clean-Mac run reaches first capture in < 10 minutes (activation target, `17_METRICS_AND_ANALYTICS.md`)

## 2. Privacy & legal

- [ ] Privacy policy **draft published** at a stable URL (covers: cloud storage on Supabase, transient AI-provider image processing, no training on user data, deletion rights)
- [ ] AI provider data-retention settings reviewed and documented (R3 mitigation, `18_RISKS_AND_OPEN_QUESTIONS.md`)
- [ ] Supabase RLS verified on all user-data tables; storage bucket not publicly listable

## 3. Pricing page (draft only — no billing)

- [ ] Pricing page draft exists (Free / Pro per `16_PRICING_AND_PACKAGING.md`) marked "coming soon"
- [ ] Tester accounts flagged free-beta; usage metering (chat count, capture count) recording from day 1
- [ ] No Stripe, no checkout, no payment collection — confirm nothing tester-facing asks for money

## 4. Reliability & observability

- [ ] Sentry wired on **Mac app** (Tauri/Rust + webview) — test crash appears in Sentry
- [ ] Sentry wired on **web app** (Next.js, client + server) — test error appears in Sentry
- [ ] Sentry alerts routed somewhere actually read (email/Slack)
- [ ] PostHog events **verified firing end-to-end** on a clean install — each canonical event observed live:
  - [ ] `capture_started`, `capture_completed`, `capture_failed` (force one failure)
  - [ ] `annotation_used`
  - [ ] `upload_succeeded`, `upload_failed` (force one via airplane mode)
  - [ ] `ai_processing_completed`, `ai_suggestion_shown`
  - [ ] `ai_suggestion_accepted`, `ai_suggestion_corrected`, `ai_suggestion_ignored`
  - [ ] `thread_created`, `thread_confirmed`
  - [ ] `chat_message_sent`, `chat_screenshot_referenced`
  - [ ] `search_performed`, `search_result_clicked`
  - [ ] `screenshot_revisited`, `screenshot_deleted`
  - [ ] `digest_generated`, `digest_viewed`
  - [ ] `onboarding_completed`
- [ ] Event properties match `specs/event_schema.md` (spot-check 5 events in PostHog)
- [ ] Dashboards 1–5 from `17_METRICS_AND_ANALYTICS.md` created; alerts configured (capture fail >2%, latency p95 >10s, upload fail >5%)

## 5. Data lifecycle

- [ ] **Storage cleanup job tested**: orphaned images (upload succeeded, DB row missing/deleted) are swept; verified by orphaning a file deliberately and confirming removal
- [ ] `screenshot_deleted` removes DB row, embedding vector, AND storage object (no ghost vectors answering searches)
- [ ] **Account deletion works end-to-end**: user-triggered delete → all rows, embeddings, storage objects, auth user gone — **hard delete verified by direct DB/storage inspection**, not just UI
- [ ] Account deletion also purges PostHog person (or documented as pseudonymous) and is reflected in the privacy policy

## 6. Support & feedback

- [ ] Feedback link inside app (menu bar + web) → email or Notion form; test submission received
- [ ] Support email address exists and is monitored (elvin@ or dedicated alias)
- [ ] Tester feedback triage destination decided (Notion board) and linked from weekly review

## 7. Distribution (Mac app)

- [ ] App **signed and notarized**; distributed as dmg (working assumption: direct distribution, Q4 in `18_RISKS_AND_OPEN_QUESTIONS.md`)
- [ ] Notarized dmg installs and passes Gatekeeper on the clean Mac (no right-click-open workaround)
- [ ] Screen-recording permission prompt flow works on first launch of the notarized build (TCC behaves differently for notarized apps — re-test, don't assume)
- [ ] Update path decided and documented (auto-updater or manual "download new dmg" — manual is acceptable for first testers if documented)

## 8. Documentation

- [ ] **Known-issues doc** written and shared with testers (bugs, missing features vs CleanShot X, post-MVP items: scrolling capture, recording, sensitive-exclude)
- [ ] One-page tester onboarding note: install steps, hotkeys, what feedback is wanted, privacy summary
- [ ] This checklist reviewed top-to-bottom in a weekly review with every box checked before the first invite goes out

## Assumptions

- First cohort is 5–10 hand-picked solo founders/marketers (Q5, `18_RISKS_AND_OPEN_QUESTIONS.md`)
- Direct distribution, not Mac App Store (Q4 — revisit if decided otherwise)
- Free beta: no payment, no billing code, pricing page is informational only

## Out of scope (this gate)

- Public launch, marketing site polish, Product Hunt, content push
- Stripe/billing (Phase 3, `16_PRICING_AND_PACKAGING.md`)
- Windows/mobile, links/PDF ingestion, team features
- SLA/uptime commitments — best-effort beta, stated in known-issues doc
