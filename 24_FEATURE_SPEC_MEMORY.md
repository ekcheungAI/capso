# 24 — Feature Spec: Memory Optimisation

> Added 2026-07-31 (owner decision D13). This surface was **absent from the original pack**: corrections were written invisibly as a side effect of filing, and nothing ever showed them back. Built in the demo track before the spec existed, so this document describes what shipped and what it must become.
> Siblings: `06_FEATURE_SPEC_AI_MEMORY.md` (the pass that produces the data), `07_FEATURE_SPEC_PROJECT_THREADS.md` (where corrections originate), `10_DATA_MODEL.md` (`user_corrections`, `revisit_events`).

## Why this exists

The product claims to learn from you. If that learning is invisible, three things break:

1. **Trust.** A wrong suggestion feels arbitrary rather than correctable — the user has no way to see *why* it guessed that, and no way to argue.
2. **Debuggability.** When suggestion quality drops, neither the user nor the builder can tell whether the few-shot window filled with bad examples.
3. **The retention story.** Memory decays without pruning. A tool that only accumulates becomes the flat screenshot folder it replaced — the exact non-goal in `01_PRODUCT_BRIEF.md`.

**Requirement:** anything the system infers about the user must be viewable and reversible. No hidden preference state.

## Scope

One route, `/memory`, with three tabs, plus one inline behaviour.

| Tab | Job | Status |
|---|---|---|
| What it learned | See and correct the inferred rules | Built (demo) |
| Tidy up | Reduce noise: duplicates, thin projects, archive | Built (demo) |
| Resurface | Review what was saved and never reopened | Built (demo) |
| *(inline)* | `why_saved` editable wherever it appears | Built (demo) |

### Tab 1 — What it learned (Requirement)

Shows, from `user_corrections` and nothing else:

- **Suggestion acceptance rate** — `accepted ÷ (accepted + overridden)` over project corrections. Target >70% by week 4 (`06_FEATURE_SPEC_AI_MEMORY.md` §6). Displayed as a plain percentage, not a chart.
- **Corrections on file** and **how many feed the next guess** (the most recent 20 — the actual few-shot window, so the number is honest about what influences behaviour).
- **Rules picked up** — corrections grouped by destination project, rendered as a sentence: *"When you correct it, you usually move things to Q3 launch campaign (3 times · mostly Competitor)."* This is a read of the ledger, never a separate learned artefact that could drift from it.
- **Correction history** — the last N corrections, each linking to its capture, each with **Forget**, which deletes the row and therefore removes it from the few-shot window.

Design constraint: this page is a ledger, not a dashboard. No sparklines, no vanity metrics (`15_DESIGN_SYSTEM_AND_UX.md` avoid-list).

### Tab 2 — Tidy up (Requirement)

- **Possible duplicates** — pairs sharing an intent and ≥2 significant title words. Demo heuristic; post-MVP should compare embeddings with a cosine threshold, plus exact `content_hash` matches which are already deduped at ingest (`specs/edge_cases.md`).
- **Thin projects** — fewer than 3 captures, where `07` states centroids are unreliable and classification falls back to the LLM signal alone. Naming the cause is the point: it tells the user why suggestions are poor for that project.
- **Archive** — archived captures leave the library, search and centroid maths but keep their rows. Restore and permanent delete both available. Archive is reversible; delete is not (F10).

Project **merge** is post-MVP: it has to re-point captures, recompute two centroids and rewrite correction targets, and is not needed until the user has enough projects to have made a mistake.

### Tab 3 — Resurface (Requirement)

Captures with **zero revisit events**, oldest first, capped at 5 per session. Each takes **Still useful** (writes a revisit, so it stops appearing) or **Archive**.

This is the manual, user-initiated form of the weekly digest deferred in `04_MVP_SCOPE.md`. It ships first precisely because it needs no scheduling, no email, and no model call — and it validates whether resurfacing has value before we build delivery for it.

### Inline — `why_saved` (Requirement, supersedes 06 §5)

`06_FEATURE_SPEC_AI_MEMORY.md` §5 says `why_saved` is "not separately editable in MVP". **That is now wrong** — owner decision. It is editable on the detail view, and each edit writes a `user_corrections` row with `field: "why_saved"`.

Rationale: `why_saved` is the model's guess at intent, and intent is the signal the whole classifier runs on. Correcting it inline is the cheapest possible training gesture, far cheaper than re-filing.

## Data

No new tables. Reads `user_corrections`, `revisit_events`, `screenshots.archived`, `project_threads`. The only schema addition is `screenshots.archived: boolean` (already in the demo store; must be added to `10_DATA_MODEL.md` when the Supabase migration lands).

## Out of scope

- Editing the raw prompt or model parameters.
- Per-rule weighting or confidence tuning by hand — corrections are examples, not knobs.
- Any learned state that exists independently of the correction ledger. If it isn't derivable from rows the user can delete, it doesn't ship.
- Scheduled digests, email delivery, notifications (post-MVP; see `04_MVP_SCOPE.md` Table 2).

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-MEM-01 | After correcting the same suggestion type 3×, the rule appears on the Learned tab naming the destination project and count. |
| AC-MEM-02 | Forgetting a correction removes it from the list and from the count of examples feeding the next guess. |
| AC-MEM-03 | Two near-identical captures appear as a duplicate pair; archiving one removes it from the library and search but not from the database. |
| AC-MEM-04 | A capture never opened since saving appears under Resurface; marking it "Still useful" removes it from that list permanently. |
| AC-MEM-05 | Editing `why_saved` persists, and the edit is visible in correction history. |

## Open questions

- Should acceptance rate be shown at all before ~20 corrections exist? A "0%" reading from a single correction is technically true and practically misleading.
- Does Resurface belong in Memory, or on the home dashboard where it would actually be seen?
- Should "Forget" ever be automatic — e.g. corrections older than 6 months aging out of the window?
