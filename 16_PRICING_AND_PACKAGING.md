# 16 — Pricing & Packaging

> Status: **Documented, not built.** No billing code ships in the MVP (locked decision #6). This doc exists so the product is SaaS-ready from day one: every gate below must be enforceable with a config flag, not a rearchitecture. Stripe integration is a later build phase (see Build Phases at bottom).
>
> Product name "Capso" is a working name, unconfirmed — see `18_RISKS_AND_OPEN_QUESTIONS.md`.

## Packaging principle (requirement)

**Never gate capture. Gate AI reasoning and history depth.**

Capture → OCR → auto-classify is the habit loop. If a free user ever hits a wall while capturing, they revert to CleanShot X and the product dies. The expensive, differentiated value — chat, semantic search over full history, digests — is what gets gated. This also aligns gates with COGS: capture-side cost is one cheap Haiku-class call (<US$0.01 target), chat-side cost is Sonnet-class per turn.

## Tiers

| | Free | Pro (~US$9/mo) | Max (placeholder — idea only) |
|---|---|---|---|
| Capture, annotation, clipboard | Unlimited | Unlimited | Unlimited |
| OCR + auto-classification + thread suggestions | Unlimited | Unlimited | Unlimited |
| AI chat messages | 50/mo | Unlimited (fair use ~1,500/mo) | Higher volume |
| Semantic search history | Last 30 days | Full history | Full history |
| Weekly digests | — | Yes | Yes |
| Project memory (few-shot corrections context) | Basic (session-level) | Full persistent | Full persistent |
| Priority processing queue | — | Yes | Yes |
| API access | — | — | Yes (idea) |
| Price | US$0 | ~US$9/mo | TBD (~US$20–25/mo, idea) |

**Free tier decisions and justification:**

- **50 AI chat messages/mo (requirement, N=50).** Enough to feel the "ask my screenshots" magic weekly, not enough to live in it. Chat is the highest-COGS action, so it is the natural meter.
- **30-day search history: YES, adopt (decision).** Justification: it does not poison the habit — capturing, OCR, and finding *recent* screenshots stays free forever, which is already better than CleanShot X. The pain of "I know I saved that in March" is precisely the persistent-memory value prop, so it converts the right moment. All data is still stored and embedded from day one; the gate is retrieval-window only, so upgrading instantly unlocks the full archive (strong upgrade moment, zero data loss).
- **Suggestions/classification free and unlimited.** They train the user's trust in the AI and cost <US$0.01/capture. Gating them would starve the correction loop (locked decision #7) of data.

## Gating dimensions

| Dimension | Gate it? | Reasoning |
|---|---|---|
| Screenshot count | **Never** | Capture is the habit loop. Gating it = user keeps CleanShot X. |
| AI chat actions | **Yes — primary gate** | Highest marginal cost (Sonnet-class), clearest perceived value. |
| Search history depth | **Yes — secondary gate** | Zero marginal cost to gate, converts at the exact moment memory value is felt. |
| Storage | **Soft cap only** (idea: 10 GB free) | Don't advertise; enforce only against abuse. Storage is cheap vs AI. |
| Project memory | **Yes** (persistent memory = Pro) | Compounding value; cheap to serve but expensive-feeling. |
| Digests | **Yes — Pro only** | Scheduled Sonnet-class cost with no user action; must be paid. |

## Unit economics (verify-at-build-time)

**Per-call cost assumptions — all labeled VERIFY AT BUILD TIME against live provider pricing:**

| Item | Assumption |
|---|---|
| Haiku-class vision call (per capture: OCR assist + classify + suggest) | US$0.004 |
| Embedding (per capture) | US$0.0002 |
| Sonnet-class chat turn (with image context in window) | US$0.03 |
| Weekly digest (Sonnet-class, batched) | US$0.15/run → ~US$0.65/mo |
| Storage (Supabase, ~1 MB/screenshot avg after compression) | US$0.021/GB/mo |
| Reference workload | 300 captures/mo + 100 chat turns/mo |

**Free user / month (300 captures, 50 chat cap):**

| Cost | Calc | US$ |
|---|---|---|
| Capture AI + embedding | 300 × (0.004 + 0.0002) | 1.26 |
| Chat (at cap) | 50 × 0.03 | 1.50 |
| Storage (~0.3 GB new + retained) | ~0.5 GB × 0.021 | 0.01 |
| **Total worst case** | | **~2.77** |

Free tier worst case ~US$2.8/mo is tolerable for a personal-tool phase but too high for open free signup at scale → future mitigations: lower N, cheaper capture model, or free-tier capture batching. Flagged in `18_RISKS_AND_OPEN_QUESTIONS.md` (model cost drift).

**Pro user / month (300 captures, 100 chat turns, digests):**

| Cost | Calc | US$ |
|---|---|---|
| Capture AI + embedding | as above | 1.26 |
| Chat | 100 × 0.03 | 3.00 |
| Digests | 4.3 × 0.15 | 0.65 |
| Storage (growing archive, yr-1 avg ~2 GB) | 2 × 0.021 | 0.04 |
| **Total COGS** | | **~4.95** |
| Revenue | | 9.00 |
| **Gross margin** | | **~45%** |

45% is thin for SaaS but acceptable for v1 given costs trend down and the reference workload is heavy. Margin levers below are requirements, not ideas.

## Margin protection rules (requirements)

1. **Cheap-pass always:** the per-capture pipeline is one Haiku-class vision call + one embedding. Sonnet-class is never invoked by a capture.
2. **Expensive only on explicit user action:** Sonnet-class runs only on chat turns and the scheduled weekly digest. No background re-analysis.
3. **Rate limits:** per-user per-minute caps on chat (e.g., 10/min) and capture processing (e.g., 30/min); "unlimited" Pro chat carries a fair-use ceiling (~1,500/mo) before throttle.
4. **Model downgrade under abuse:** past fair-use ceiling, chat silently routes to Haiku-class with a notice, never hard-cuts.
5. **Cache embeddings:** embed once per screenshot; re-ranking and repeat searches reuse cached vectors. Never re-embed on search.
6. **(Idea)** Batch API / off-peak processing for digests and backfills.

## Competitive price anchors

| Product | Price | What it anchors |
|---|---|---|
| CleanShot X | US$29 one-time + Cloud Pro US$8/mo | Capture UX bar; proves users pay a sub for screenshot *cloud* features |
| mymind | US$6–13/mo | AI memory/"remember everything" subscription is an accepted category |
| Raycast Pro | US$8/mo | Solo-pro AI utility at US$8 = the price band Capso sits in |

US$9/mo sits inside the accepted band for exactly this buyer (solo founder/marketer paying for Raycast, CleanShot, mymind already).

## Why subscription, not one-time

Every active user incurs ongoing AI COGS (~US$1–5/mo). A one-time US$29 price is consumed by ~6 months of an average user's inference. One-time pricing works for CleanShot because its marginal cost is ~zero; Capso's core value *is* recurring inference and storage. Hybrid (one-time app + AI sub) is rejected for v1: two SKUs, one dev.

## Build phases (billing)

1. **MVP (now):** no billing. Tier flags exist in DB (`plan: free|pro`), owner account hardcoded `pro`. Usage metering (chat count, capture count) recorded from day 1 via events in `17_METRICS_AND_ANALYTICS.md`.
2. **Phase 2:** pricing page live (required before first external tester — see `23_LAUNCH_CHECKLIST.md`), free beta, meters visible in UI.
3. **Phase 3:** Stripe Checkout + customer portal, enforcement of gates, dunning. Only after external testers validate willingness to pay.

## Assumptions

- Working name "Capso" (unconfirmed).
- All per-call prices above are estimates as of 2026-07; **verify at build time**.
- Reference workload (300 captures / 100 chats) is owner-derived, not market-validated.
- Single-currency USD pricing; no regional pricing in scope.

## Out of scope

- Team/seat pricing, annual plans, lifetime deals, education discounts.
- Max tier spec (placeholder only; do not design).
- Billing code, tax handling, invoicing — Phase 3.
