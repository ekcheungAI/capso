# 01 — Product Brief: Capso

> Status: planning. Siblings: 02_USER_PROBLEMS_AND_JTBD.md, 03_PERSONAS_AND_USE_CASES.md, 04_MVP_SCOPE.md.
> Project root: `~/Desktop/ekOS/20_projects/Capso`

## One-line pitch

Capso turns every screenshot you take into searchable, project-aware AI memory — capture like CleanShot, remember like a second brain, retrieve by typing a sentence.

## Assumptions

| # | Assumption | Risk if wrong |
|---|---|---|
| A1 | "Capso" is a working name, not confirmed or trademark-checked | Rename before any public launch; keep the name out of code identifiers where cheap to do so (bundle ID can change at rename) |
| A2 | Owner-user (Elvin, HK-based solo founder/AI educator) is customer zero; his workflow defines v1 | If SaaS demand diverges, revisit at post-MVP, not in MVP |
| A3 | One cheap multimodal call + one embedding call ≤ US$0.01/capture holds at real volume | Re-route to cheaper OCR-first pipeline if exceeded |
| A4 | macOS `screencapture -i` / `-iw` shell-out is acceptable capture quality for MVP | Native capture APIs are a post-MVP upgrade, not a blocker |

## Product vision

Screenshots are the fastest note-taking gesture that exists — one hotkey, zero typing. But every current tool treats the screenshot as the end of the workflow. Capso treats it as the beginning: the moment of capture is the moment of memory formation.

The vision in three layers:

1. **Capture layer (replace CleanShot X):** global-hotkey region/window capture, clipboard copy, quick annotation, floating thumbnail overlay. Good enough to cancel the CleanShot subscription on day one of daily use.
2. **Memory layer (go beyond):** every capture is auto-OCR'd, summarized, typed, and routed to a project thread by a cheap AI call — with the user confirming or correcting on the overlay in one click. Corrections are stored and fed back as few-shot context, so classification gets better with use (requirement, see decision 7 in shared context; no fine-tuning).
3. **Retrieval layer (the payoff):** weeks later, type "that pricing page with the annual toggle I saved for the landing page redesign" and get the screenshot — then ask follow-up questions about it in a project thread with full context.

Personal tool first. But the economics (per-capture AI cost target <US$0.01, Haiku-class for ingestion, Sonnet-class only for chat/digests) and the architecture (Supabase multi-tenant-ready, `capture_kind` enum for future links/PDFs) are SaaS-ready from day one. Freemium pricing is documented in 04_MVP_SCOPE.md; billing is explicitly not built in MVP.

Design tone benchmark: mymind.com — calm, private, zero folders to manage. Borrow the feeling (no-filing, instant retrieval, quiet UI), don't clone the product (mymind is a bookmarking brain; Capso is a screenshot-native working memory with project threads and chat).

## Why now

| Shift | What changed | Why it unlocks Capso |
|---|---|---|
| AI vision got cheap | Haiku-class multimodal models do OCR + summary + classification in one structured-JSON call for well under a cent | Per-capture intelligence is now economically trivial; this was cost-prohibitive 18 months ago |
| Model routing is a solved pattern | Cheap model for ingestion, expensive model only for user-initiated chat/digests | Unit economics work for a personal tool AND a US$9/mo SaaS tier |
| Screenshot overload is universal | Screenshots are the default "save this" gesture; folders of thousands of unnamed PNGs are the norm | The pain is felt daily by exactly the people who screenshot most (builders, marketers, designers) |
| Incumbents have zero intelligence | CleanShot X is a best-in-class capture tool with no OCR search, no classification, no memory, no chat | The capture market leader left the entire memory layer on the table |
| Agent build loops | A lean Tauri + Next.js + Supabase MVP is a 2–4 week agent-assisted build, not a 6-month project | Solo founder can ship this without a team (see 04_MVP_SCOPE.md forcing function) |

## Target outcome for the user

After 30 days of daily use, the owner-user should be able to say all of the following:

- "I cancelled CleanShot X and lost nothing I use daily." (capture parity on region/window/clipboard/basic annotation)
- "I never manually file a screenshot. I press one hotkey, optionally click one confirmation, and move on." (<2 seconds of user attention per capture)
- "When I need a screenshot from three weeks ago, I type a sentence and find it in under 30 seconds." (semantic + OCR search)
- "When I hit a UX bug, I screenshot it and am chatting with AI about it — with the image attached, in the right project thread — within 10 seconds." (Ask AI on overlay)
- "My design references, competitor screenshots, and bug reports live in project threads I never had to create folders for."

The meta-outcome: **externalized memory**. The user executes instead of remembering. See 02_USER_PROBLEMS_AND_JTBD.md for the underlying jobs.

## Positioning statement

**For** solo founders, marketers, and product builders who screenshot constantly as their fastest form of note-taking, **who** lose those screenshots to unnamed files and flat galleries the moment they're captured, **Capso is** a screenshot-first AI memory tool that captures like a pro tool and then OCRs, classifies, and files every shot into project threads you can search in plain language and chat with, **unlike** CleanShot X (excellent capture, zero intelligence, no memory), mymind (beautiful bookmarking brain, but not screenshot-native, no project threads, no capture tooling, no chat-about-this-image), and ShotSnap-style auto-filers (auto-tagging into a flat gallery is organization theater — tags without retrieval-by-meaning and without conversation are still a junk drawer).

### Competitive one-liner table

| Competitor | What they do well | What they don't do | Capso's wedge |
|---|---|---|---|
| CleanShot X | Best-in-class capture UX, annotation, scrolling capture | No OCR search, no AI, no organization, no memory | Match daily-driver capture, add the entire memory layer |
| mymind | Calm design, no-folders saving, visual search | Not screenshot-native, no Mac capture bar, no project context, no AI chat about saved items | Screenshot-first, project threads, conversational retrieval |
| ShotSnap-style auto-filers | Auto-tags screenshots | Flat gallery; tags ≠ meaning; no chat; no project routing; no learning from corrections | Confirm-on-overlay routing + semantic search + thread chat + learning loop |
| Apple Screenshots + Spotlight | Free, built-in OCR (Live Text) | No classification, no projects, no chat, retrieval limited to literal text | Meaning-based retrieval and project memory, not just text match |

## Non-goals

These are permanent positioning boundaries, not deferrals (deferrals live in 04_MVP_SCOPE.md):

- **Not social bookmarking.** No sharing, no public collections, no follow graphs. Capso is private memory.
- **Not a generic notes app.** No freeform documents, no markdown editor, no task lists. Text in Capso exists as OCR, AI annotations, and chat — all anchored to captures.
- **Not a dev-only screenshot pipe.** Not a CLI-to-S3 uploader or an issue-tracker attachment bot. The user is a marketer/founder/builder, and the product is a memory system, not plumbing.
- **Not a flat gallery with auto-tags.** If retrieval degrades to scrolling a grid of tagged thumbnails, the product has failed its core promise. Project threads + natural-language retrieval are the product.

## Success criteria for the planning pack

An implementation agent reading 01–04 (plus future data-model/architecture docs, e.g. a 10_DATA_MODEL.md) should be able to start building without asking product questions. Scope disputes are settled by 04_MVP_SCOPE.md; the litmus test there is authoritative.
