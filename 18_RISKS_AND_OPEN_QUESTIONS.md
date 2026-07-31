# 18 — Risks & Open Questions

> Review cadence: risk register re-scored at each weekly review; tripwires are hard triggers, not suggestions. Cross-refs: scope litmus in `04_MVP_SCOPE.md`, capture spec in `05_FEATURE_SPEC_CAPTURE.md`, metrics in `17_METRICS_AND_ANALYTICS.md`, tester gate in `23_LAUNCH_CHECKLIST.md`.

## Risk register

| # | Risk | Likelihood | Impact | Mitigation | Tripwire (act immediately) |
|---|---|---|---|---|---|
| R1 | **Scope creep** — the biggest risk. "Screenshot memory" invites links, PDFs, recordings, teams, mobile. 2–4 week MVP becomes 4 months. | High | High | Every feature request passes the `04_MVP_SCOPE.md` litmus test; v1 = screenshots only (locked decision #1); links/PDFs stay architecture-ready but unbuilt; new ideas go to a parking-lot section, not the build queue. | Any week where >20% of build time went to non-locked-scope work; or MVP not dogfood-able by end of week 4. |
| R2 | **Capture parity gap vs CleanShot X** — if capture feels slower or worse, the owner keeps CleanShot, the habit never forms, and the memory layer starves. | Medium | High | Basic annotation set + fast capture bar are MVP requirements (locked decision #2); capture-to-clipboard must feel instant (upload is background, locked decision #3); measure capture failure rate <1% (`17_METRICS_AND_ANALYTICS.md`). | Owner still reaching for CleanShot X after 2 weeks of dogfood → stop feature work, fix capture UX only. |
| R3 | **Privacy** — screenshots routinely contain API keys, tokens, customer data, revenue dashboards. Cloud-everything posture (locked decision #4) concentrates that in Supabase + transient provider exposure. | Medium | High | Accepted for MVP as personal tool; document AI providers' data-retention settings and confirm **no training on API data**; Supabase RLS on every table; storage bucket private; sensitive-exclude feature is committed post-MVP; privacy policy drafted before any external tester (`23_LAUNCH_CHECKLIST.md`). | Any screenshot containing a live secret found in provider logs/config review; or an external tester asks a privacy question the docs can't answer. |
| R4 | **AI hallucination in chat** — chat invents facts not present in any screenshot; user trust collapses on first confident lie. | Medium | Medium–High | **Requirement: every chat answer cites which screenshots it used** (thumbnails/IDs inline); retrieval-then-answer only — no answers from model memory about "your data"; "not found in your screenshots" is a first-class response. | First observed answer citing zero screenshots or wrong screenshot → block tester onboarding until citation UX fixed. |
| R5 | **Poor auto-grouping** — thread suggestions are wrong/annoying, user ignores overlay, everything rots in Inbox, memory value never materializes. | Medium | High | Confidence threshold: below threshold suggest nothing (silent Inbox) rather than suggest wrongly; one-tap correction on overlay; corrections feed few-shot context (locked decision #7); acceptance-rate metric watched weekly (target ≥60% by week 4). | Acceptance <40% at week 4, or "% captures in threads" <50% for 2 consecutive weeks. |
| R6 | **Subscription resistance** (future SaaS) — solo users balk at another US$9/mo. | Medium | Medium | Free tier keeps unlimited capture (habit before paywall); gates aligned with felt value (`16_PRICING_AND_PACKAGING.md`); anchors (Raycast, mymind) validate the band; personal tool works regardless — SaaS is optional upside. | <5% of engaged external testers say they'd pay when asked directly. |
| R7 | **Platform complexity** — Tauri 2 menu-bar app + macOS screen-capture permissions (ScreenCaptureKit, TCC prompts, notarization) burns MVP weeks. | Medium | Medium | Spike capture permissions in week 1 before anything else; keep capture layer thin (native APIs, minimal custom UI); **Electron fallback rule:** if Tauri capture/permissions are not working end-to-end after 5 build days, switch to Electron and accept the bundle size. | Day 5 of capture spike without a working hotkey→capture→clipboard loop. |
| R8 | **Model cost drift** — per-capture cost exceeds the <US$0.01 target or chat COGS erodes margin as usage grows. | Low–Medium | Medium | Cost-per-user tracked monthly vs `16_PRICING_AND_PACKAGING.md` assumptions; margin rules enforced (cheap-pass always, expensive only on user action, caching); model routing is config, not code — swap to cheaper models without release. | Capture pipeline cost >US$0.015/capture measured, or monthly AI spend >US$15 during dogfood. |
| R9 | **Single-dev bus factor / maintenance** — one person (plus agents) owns a Mac app, a web app, and a backend; macOS updates and dep churn never stop. | High (long-term) | Medium | Boring stack already chosen (Tauri/Next/Supabase — all used elsewhere in ekOS); agent-buildable codebase with docs-as-specs (this pack); minimal surface area (R1); Sentry so breakage is seen, not discovered; monthly maintenance budget of ~0.5 day. | Two consecutive weeks where maintenance displaces all feature/dogfood time; or a macOS beta breaks capture with no fix path. |

## Open questions

| # | Question | Owner | Decide by | Notes |
|---|---|---|---|---|
| Q1 | **Final product name** — "Capso" is a working name, unconfirmed. Trademark + domain + App Store name check needed. | Elvin | Before pricing page / any public artifact | Run `brand-name-search` flow; until then, no public-facing use of the name. |
| Q2 | **Embedding provider choice** — Voyage vs OpenAI vs open-source via API; dimension/cost/quality trade-off; pgvector index sizing follows from it. | Build loop wk 1 | Before first embedding written | Migration = re-embed everything; decide early. Verify pricing at build time. |
| Q3 | **Digest cadence and channel** — weekly is assumed; in-app vs email vs both? Email adds a dependency (Resend?) pre-testers. | Elvin | Before digest build (post-core MVP) | Start in-app only (idea); email later. `digest_generated`/`digest_viewed` events already defined. |
| Q4 | **Mac App Store vs direct distribution** — MAS adds sandbox pain for screen capture + 30% cut on subs; direct needs notarized dmg + updater (Sparkle-equivalent for Tauri). | Elvin | Before first external tester | Working assumption: direct distribution. `23_LAUNCH_CHECKLIST.md` assumes signed + notarized dmg. |
| Q5 | **When to open to first external testers** — gated by dogfood exit criteria (`23_LAUNCH_CHECKLIST.md`), but how many, from where (X audience? friends?), and under what feedback loop? | Elvin | After dogfood exit criteria met | Suggest 5–10 hand-picked solo founders/marketers; feedback via support flow in checklist. |
| Q6 | **Links / PDF ingestion timing** — architecture-ready by design (locked decision #1), but when to actually build? | Elvin | Not before D30 retention data exists | Litmus: only when screenshot loop retention is proven; otherwise it's R1 (scope creep) wearing a costume. |

## Assumptions

- Owner-user (Elvin) is a valid proxy for the target persona during dogfood (`03_PERSONAS_AND_USE_CASES.md`).
- Supabase + Vercel remain the stack; no multi-region, no self-hosting questions in this horizon.
- Likelihood/impact scores are pre-build estimates; re-score weekly.

## Out of scope

- Legal/compliance beyond the privacy items above (GDPR tooling, DPAs) — revisit at SaaS phase.
- Competitive-response risks (a big player shipping this) — unmitigable at this size; ship faster instead.
- Team/multi-user risks — single-user product for this entire horizon.
