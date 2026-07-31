# 04 — MVP Scope

> The critical doc. When any scope question arises during build, this file wins.
> Siblings: 01_PRODUCT_BRIEF.md (vision/positioning), 02_USER_PROBLEMS_AND_JTBD.md (jobs J1–J11), 03_PERSONAS_AND_USE_CASES.md (UC1–UC6). Data model and architecture: see future 10_DATA_MODEL.md / 11_ARCHITECTURE.md.

## The litmus test (apply to every feature request)

**If a feature does not support the screenshot → AI → memory → retrieval loop, it's out.**

Corollaries:
- If it supports the loop but isn't needed to run the loop end-to-end daily, it's NICE-TO-HAVE LATER.
- If it serves a different product (collaboration, publishing, general document management), it's EXPLICITLY EXCLUDED.
- "Architecture-ready" ≠ "built". The `capture_kind` enum exists in the schema (locked decision 1); only `screenshot` is implemented.

## The forcing function

**Lean MVP usable in ~2–4 weeks of agent build loops** (locked decision 5). This is the scope regulator: any feature that threatens the window gets cut or deferred, not "done quickly". The MVP is done when the owner-user cancels CleanShot X and runs the full loop daily — not when the backlog is empty.

## Table 1 — MUST-HAVE in MVP

All rows are **requirements**. Platform: Tauri 2 menu-bar Mac app (React+TS) + Next.js 15 web app (Vercel) + Supabase (Postgres + pgvector, Storage, Auth, Edge Functions, jobs table + pg_cron).

| ID | Feature | Definition of done | Serves (JTBD / UC) |
|---|---|---|---|
| M1 | Mac capture bar: global-hotkey region + window capture, copy-to-clipboard | Hotkeys work from any app; MVP shells out to macOS `screencapture -i` / `-iw`; PNG lands on clipboard and in the upload queue | J1, J2 / all UCs |
| M2 | Basic annotation quick editor | Arrow, box, text, blur on the fresh capture; annotated version is what's saved/copied; opens from overlay; no layers/undo-history polish | J2 / UC1, UC3 |
| M3 | Background upload pipeline | Capture → local queue → Supabase Storage + `captures` row; survives offline (retry via queue); capture is never blocked or lost by network | J1 / UC4 |
| M4 | Post-capture floating thumbnail overlay | CleanShot-style overlay ~1s after capture; inline AI suggestion "Project = X, Type = Y" within ~3–5s; one-click confirm/adjust; ignore → auto-saves to Inbox; "Ask AI" button opens thread chat with the screenshot attached | J1, J3, J7 / UC1, UC2, UC5 |
| M5 | OCR + classification pipeline + learning loop | One Haiku-class multimodal call per capture returns structured JSON {ocr_text, summary, type, intent, project_suggestion, confidence, why_saved} + one embedding call; target <US$0.01/capture; confidence routing ≥0.8 auto-assign (editable) / 0.5–0.8 suggest / <0.5 Inbox; confirmations & corrections stored and injected as few-shot context (no fine-tuning) | J3, J4 / UC4, UC5 |
| M6 | Project threads | User can create/rename projects; captures route into threads; thread view = chronological captures + chat in project context; Inbox is the default thread for unrouted captures | J6 / UC1–UC3, UC5, UC6 |
| M7 | Semantic + OCR search (web app) | One search box: pgvector similarity + Postgres full-text over ocr_text/summary, merged results; natural-language queries return the right capture from weeks back | J5 / UC6 |
| M8 | Thread chat with screenshot context | Sonnet-class calls on user chat turns ONLY; screenshot(s) + thread history in context; entry points: overlay "Ask AI" and web thread view | J7, J8 / UC1, UC6 |
| M9 | Web dashboard/inbox | Recent captures grid, Inbox triage (assign to project in one click), project list, search box; calm mymind-tone UI (borrow, don't clone — see 01_PRODUCT_BRIEF.md) | J3, J6 / UC5, UC6 |

**MVP acceptance test (end-to-end):** hotkey-capture a competitor pricing page → overlay suggests correct project within 5s → confirm with one click → three weeks later type "competitor pricing with annual toggle" in the web app → find it → open thread → ask "compare this to our pricing" → get a grounded answer. Plus: CleanShot X subscription cancelled.

## Table 2 — NICE-TO-HAVE LATER (deferred, not rejected)

These pass the litmus test or support trust/monetization, but are not needed to run the loop daily. Do not build any of these inside the 2–4 week window.

| Feature | Why deferred | Earliest trigger to build |
|---|---|---|
| Scrolling capture | Capture-parity luxury; region/window covers ~90% of daily volume (locked decision 2) | Owner misses it >2×/week after a month of daily use |
| Screen recording / GIF | Different pipeline (video), zero memory-loop value in v1 (locked decision 2) | Only if it blocks cancelling another paid tool |
| Sensitive-exclude toggle + app blocklist | MVP privacy posture is owner's own Supabase, transient AI provider access (locked decision 4) | Before any non-owner user touches the product |
| Weekly digests | Paid-tier payoff (Sonnet-class), needs weeks of capture history to be meaningful (J9) | After 4+ weeks of real capture data |
| Mobile capture/app | Owner's workflow is Mac-first; web app covers mobile retrieval reads | Clear retrieval-on-phone demand |
| Links / PDFs / files ingestion | `capture_kind` enum ships in schema; implementations do not (locked decision 1, J11) | Post-MVP roadmap decision |
| Mascot / personality layer | Brand polish, zero loop value | Post-PMF branding pass |
| Billing (Stripe) + tier enforcement | Freemium model documented (free: capture + OCR + limited AI actions/mo; ~US$9/mo: unlimited AI chat, semantic search, weekly digests, project memory) but NOT built (locked decision 6) | First external paying-intent user |
| Native capture engine (replace `screencapture` shell-out) | Shell-out is good enough for MVP | Quality/latency complaints in daily use |

## Table 3 — EXPLICIT EXCLUSIONS (not deferred — out)

| Exclusion | Why it fails the litmus test |
|---|---|
| Team collaboration (shared threads, comments, roles, workspaces) | Different product with different economics; Capso is single-player memory (01_PRODUCT_BRIEF.md non-goals) |
| Social / sharing (public collections, follow graphs, share pages) | Capso is private memory; sharing is antithetical to the trust posture |
| General document management (folders, file browser, arbitrary uploads) | Screenshot-first is the wedge; generic DM dissolves the classifier's intent signal and the positioning |
| Browser-wide / filesystem-wide ingestion ("save everything automatically") | Capture must stay an intentional gesture — intent is classifier signal; bulk ingestion floods memory with noise |

## Scope creep tripwires

Tempting expansions that WILL come up mid-build. Stock answer for every row: **"Defer. Log it, cite 04_MVP_SCOPE.md, keep building the loop."**

| Tripwire (the tempting thought) | Why it's a trap | Answer |
|---|---|---|
| "Scrolling capture is small, CleanShot has it" | Different capture mechanics, days not hours; explicitly deferred by locked decision 2 | Defer |
| "Let's just add link saving, the enum already exists" | Enum ≠ fetcher + parser + renderer + new classify prompts; v1 input is screenshots ONLY (locked decision 1) | Defer |
| "Tags/folders alongside projects, for flexibility" | Reintroduces manual filing — the exact pain being removed; flat-gallery-with-tags is a named non-goal | Defer (reject-flavored) |
| "Fine-tune / build a custom classifier model" | Locked decision 7: few-shot injection of stored corrections only | Defer |
| "Add Stripe now since SaaS-ready is a goal" | SaaS-ready = economics + schema, not checkout; locked decision 6 | Defer |
| "Full annotation suite (highlighter, crop, counter, emoji)" | Basic four (arrow, box, text, blur) is the requirement; parity-chasing CleanShot's editor eats the window | Defer |
| "Polish the overlay animations for a week" | mymind-calm ≠ motion design sprint; ship functional-calm, iterate in daily use | Defer |
| "Batch-import my old screenshot folder on day one" | Import floods the classifier with intent-less history and burns the AI budget; loop first, backfill later | Defer |
| "Multi-user auth 'while we're in there'" | Team collaboration is an explicit exclusion; Supabase Auth single-user is enough | Defer |
| "Swap in a fancier/expensive model for classification" | Breaks <US$0.01/capture economics; Sonnet-class is reserved for chat turns and digests | Defer |
| "Add a notes field / markdown editor on captures" | Generic notes is a named non-goal; why_saved + chat cover annotation-of-intent | Defer |
| "Windows/Linux capture app" | Owner is Mac; Tauri makes it *possible* later, which is exactly why it shouldn't be *now* | Defer |

**Process rule (requirement):** when a tripwire fires mid-build, the implementation agent appends one line to a `~/Desktop/ekOS/20_projects/Capso/DEFERRED_LOG.md` (created on first use) and continues. No design discussion inside the build loop.

## Assumptions

- A1: 2–4 week window assumes agent build loops with the decided stack and no platform surprises (notably macOS permissions for global hotkeys/capture in Tauri — highest technical risk, spike first).
- A2: "Usable" = owner-user daily-drives it and cancels CleanShot X; not App Store-ready, not notarization-polished beyond what daily use requires.
- A3: Free-tier AI action limits need no enforcement code in MVP (single user); documented numbers are for the pricing page later.

## Out of scope for this document

- Schema/table design → 10_DATA_MODEL.md. Prompt templates and routing details → future AI pipeline doc. Build sequencing/milestones → future build plan doc. This doc governs *what*, not *how* or *when-in-what-order*.
