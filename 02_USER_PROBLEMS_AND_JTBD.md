# 02 — User Problems & Jobs-to-be-Done

> Siblings: 01_PRODUCT_BRIEF.md (positioning), 03_PERSONAS_AND_USE_CASES.md (who + scenarios), 04_MVP_SCOPE.md (what ships).
> All problems below are sourced from the owner-user's (customer zero's) actual workflow. Treat as requirements input, not hypotheses to re-validate before MVP.

## The core problem in one paragraph

Screenshots are the user's highest-frequency capture gesture — faster than notes, bookmarks, or clipping tools — but every screenshot dies at the moment of capture. It lands as `Screenshot 2026-07-31 at 14.22.03.png` on the Desktop or in a CleanShot folder: no context about why it was saved, no connection to the project it belongs to, no way to find it later except scrubbing thumbnails by date. The user's memory of "I saved something about this" outlives their ability to find it. The result is re-searching the web for things already captured, losing design/competitor references, and carrying organizational guilt about a folder of thousands of dead pixels.

## Pain inventory

| # | Pain | Evidence in daily workflow | Cost |
|---|---|---|---|
| P1 | Screenshots get lost/buried | Hundreds of timestamp-named PNGs across Desktop/Downloads/CleanShot history | Re-finding takes minutes or fails entirely; duplicates pile up |
| P2 | No context on *why* it was saved | A pricing-page shot from 3 weeks ago: was it competitor research, design inspiration, or a bug report? | Even when found, the shot is useless without recalling intent |
| P3 | Hard to search later | Filenames are timestamps; Finder/Spotlight can't answer "the dashboard with the dark sidebar" | Retrieval is scroll-and-squint by date; meaning-based queries impossible |
| P4 | References fragmented across time and projects | Design inspo, marketing swipes, and UX bug shots for 6+ concurrent projects (see `~/Desktop/ekOS` structure) interleave in one chronological stream | No per-project view; assembling references for one project means re-triaging everything |
| P5 | Can't ask follow-up questions | A saved screenshot is inert — can't ask "what font is this?", "why does this layout break?", "how does their pricing compare to mine?" | User re-uploads shots into ChatGPT/Claude manually, losing the saved context and project linkage every time |
| P6 | Memory burden blocks execution | User must *remember* what was saved, where, and why, to make it useful | Working memory spent on librarian work instead of building/marketing; things saved are effectively things forgotten |

P6 is the umbrella pain: P1–P5 are its mechanisms. The product goal is **externalized memory** — the system remembers so the user can execute.

## Jobs-to-be-Done

Format: *When I [situation], I want to [motivation], so I can [outcome].* Each JTBD maps to a Capso capability and its MVP status (MVP feature IDs reference the MUST-HAVE table in 04_MVP_SCOPE.md).

| ID | Job (When… I want… so I can…) | Pain | Capso capability | MVP feature (or post-MVP) |
|---|---|---|---|---|
| J1 | When I see something worth keeping on screen, I want to capture it with one hotkey and zero filing decisions, so I can stay in flow | P1, P6 | Global-hotkey region/window capture; save-to-Inbox even if overlay ignored | MVP — M1 capture bar, M4 overlay |
| J2 | When I capture a bug or reference to share, I want to mark it up and copy it in seconds, so I can drop it into chat/email/issue without opening an editor app | P1 | Quick editor: arrow, box, text, blur; copy-to-clipboard | MVP — M2 annotation, M1 clipboard |
| J3 | When I've just captured something, I want the system to guess why I saved it and which project it belongs to, and let me confirm with one click, so context is attached at the moment it still exists in my head | P2, P4 | Auto OCR/classify (structured JSON: type, intent, summary, why_saved, project_suggestion, confidence); inline suggestion on overlay in ~3–5s; confidence routing (≥0.8 auto-assign, 0.5–0.8 suggest, <0.5 Inbox) | MVP — M5 pipeline, M4 overlay confirm |
| J4 | When I correct a wrong suggestion, I want the system to learn my projects and habits, so suggestions get more accurate the more I use it | P2, P6 | Confirmations/corrections stored as data, injected as few-shot context into classification prompts (no fine-tuning — locked decision) | MVP — M5 learning loop |
| J5 | When I need something I saved weeks ago, I want to type a natural-language sentence and get the screenshot, so I don't scrub thumbnails or re-search the web | P1, P3 | Semantic (pgvector) + OCR full-text search in web app | MVP — M7 search |
| J6 | When I'm working on a specific project, I want all its screenshots in one thread with running context, so references stop fragmenting across my whole capture history | P4 | Project threads; captures routed to threads; thread as retrieval and conversation surface | MVP — M6 project threads |
| J7 | When I'm staring at a captured bug or reference, I want to ask AI about it immediately with the image attached, so analysis happens in context instead of a copy-paste round trip to a chatbot | P5 | "Ask AI" button on overlay → opens thread chat with screenshot attached; Sonnet-class chat with screenshot + thread context | MVP — M4 overlay Ask AI, M8 thread chat |
| J8 | When I review a project, I want to converse across everything saved to it ("compare these three pricing pages"), so saved references become synthesized decisions | P5, P4 | Multi-capture thread chat within a project | MVP — M8 (thread-scoped); cross-thread synthesis quality improves post-MVP |
| J9 | When a week ends, I want a digest of what I captured and what it implies, so passive capture turns into active review | P6 | Weekly AI digest (Sonnet-class) | Post-MVP (paid-tier feature, see 01_PRODUCT_BRIEF.md monetization + 04_MVP_SCOPE.md nice-to-have) |
| J10 | When I capture something sensitive, I want it excluded from cloud/AI automatically, so I can trust the always-on capture habit | trust enabler | Sensitive-exclude toggle + app blocklist | Post-MVP (locked decision 4; MVP posture: owner's own Supabase, AI providers see images transiently) |
| J11 | When I save a link or PDF, I want it in the same memory, so all references live in one system | P4 | `capture_kind` enum in data model (see future 10_DATA_MODEL.md) | Post-MVP — architecture-ready only, explicitly NOT built (locked decision 1) |

## Priority reading of the table

- **The irreducible MVP loop is J1 → J3 → J5/J7.** Capture without filing, context attached at capture time, retrieval by meaning, chat in context. Every MUST-HAVE in 04_MVP_SCOPE.md serves one of these.
- **J2 exists to cancel CleanShot X.** It buys daily-driver status; without it the memory features never see real volume.
- **J4 is the moat mechanic.** Cheap to build (store corrections, inject as few-shot), compounds with use, and is data no competitor has about this user.
- **J9–J11 are documented so the architecture doesn't foreclose them** — not so anyone builds them in the 2–4 week window.

## Out of scope (problems Capso deliberately does not take on)

- Team knowledge sharing / collaborative libraries — Capso is single-player memory (see non-goals in 01_PRODUCT_BRIEF.md and exclusions in 04_MVP_SCOPE.md).
- General note-taking, task management, or read-later — adjacent jobs served by other tools; Capso only ingests screenshots in v1.
- Whole-browser or filesystem ingestion ("save everything automatically") — capture stays an intentional gesture; intent is part of the signal the classifier relies on.
