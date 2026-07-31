# 03 — Personas & Use Cases

> Siblings: 01_PRODUCT_BRIEF.md (positioning), 02_USER_PROBLEMS_AND_JTBD.md (pains P1–P6, jobs J1–J11), 04_MVP_SCOPE.md (feature IDs M1–M9).
> Exactly three personas. Persona A is **customer zero** — the owner-user (Elvin). MVP decisions are settled by Persona A's workflow; B and C exist to keep the SaaS-ready surface honest, not to add MVP scope.

## Persona A — Solo marketer/founder (CUSTOMER ZERO)

**Profile.** Hong Kong–based solo founder and AI educator. Runs a personal brand content engine, multiple product projects, and incubator experiments simultaneously (see `~/Desktop/ekOS` structure). Lives in a Mac + browser + AI-chat workflow all day. Currently pays for CleanShot X.

| Dimension | Reality |
|---|---|
| Daily screenshot habits | 15–40/day: hotkey region captures of anything worth keeping, window captures for bug reports and content assets |
| What they save | Competitor landing pages and pricing, viral post formats and hooks, AI tool UIs and outputs, own-product bugs, dashboards/metrics, payment and account confirmations, course/tutorial frames |
| What they want to retrieve later | "That competitor pricing table from last month", "hook formats I saved for Reels", "the Supabase error from the HeyOmmi deploy", everything saved for one specific project in one place |
| Why current tools fail | CleanShot captures perfectly, then dumps to a folder (P1). Intent evaporates (P2). Finder/Spotlight can't do meaning (P3). 6+ concurrent projects interleave in one chronological stream (P4). Asking AI about a shot means a manual re-upload to a chatbot with zero saved context (P5) |

**Success statement.** "I cancelled CleanShot, I never file anything, and any screenshot from any project is one typed sentence away — or one 'Ask AI' click away at capture time."

## Persona B — Product builder/designer hybrid

**Profile.** Solo or tiny-team builder who designs and ships their own product. Splits days between Figma/code and reference-hunting. (For the owner-user, this is his builder hat on HeyOmmi/UnitScrope days — the personas overlap in one human, which is exactly why one tool must serve both.)

| Dimension | Reality |
|---|---|
| Daily screenshot habits | 10–30/day: UI states of their own app (before/after, broken/fixed), other products' components and flows, error dialogs, Figma frames |
| What they save | Design inspiration (nav patterns, empty states, onboarding flows), visual bugs to fix later, competitor feature UIs, design-system references |
| What they want to retrieve later | "Empty states I've saved" when designing one; every capture of a recurring bug in one place; "how did app X do their paywall" mid-design |
| Why current tools fail | Inspiration tools (mymind, Pinterest-style boards) are separate from bug-capture tools, so references fragment by tool as well as by time (P4). Bug screenshots have no thread — each recurrence is a fresh orphaned file. Can't ask "why does this layout break at this width?" of a saved capture (P5) |

**Capso answer.** One capture gesture for both inspiration and bugs; classification (`type`: inspiration vs bug vs reference) separates them automatically; project threads collect them; overlay "Ask AI" turns a bug screenshot into an immediate debugging conversation (use case UC1).

## Persona C — Growth/marketing operator

**Profile.** Runs acquisition and content for one or more products. Ad accounts, analytics dashboards, competitor feeds, and creative swipe files all day. May be an early SaaS customer archetype post-MVP.

| Dimension | Reality |
|---|---|
| Daily screenshot habits | 20–50/day: ad creatives from feeds, competitor emails/landing pages, analytics snapshots (numbers that will change and be unrecoverable), winning post formats |
| What they save | Swipe file material, before/after metric snapshots, competitor funnel steps (each step one screenshot), pricing/promo changes over time |
| What they want to retrieve later | "All the ads I saved with a UGC hook", "competitor X's pricing page in May vs July", the metric snapshot that proves a claim in a report |
| Why current tools fail | Swipe files decay into camera-roll chaos (P1); a metrics screenshot without a date-and-why is worthless in a report (P2); comparing captures across time requires finding them all first (P3, P4); no way to ask "what do these five winning ads have in common?" (P5) |

**Capso answer.** OCR makes every number and headline searchable (M5, M7); timestamps + `why_saved` give snapshots provenance; project threads hold a competitor's history in sequence; thread chat synthesizes across saved creatives (UC6).

## Primary use cases

Six use cases. Feature IDs reference 04_MVP_SCOPE.md MUST-HAVE table. All six are MVP-served (that is deliberate — the MVP is the loop, and these are the loop).

| # | Use case | Primary persona | Flow | Features exercised |
|---|---|---|---|---|
| UC1 | UX/UI bug debugging via capture-into-AI-chat | B (and A wearing builder hat) | Hotkey-capture the broken UI → overlay appears → click "Ask AI" → thread chat opens with screenshot attached in the right project → discuss cause/fix; later captures of the same bug land in the same thread | M1, M4, M5, M6, M8 |
| UC2 | Design inspiration collection | B, A | Capture any UI worth stealing → AI types it as inspiration, suggests project (or Inbox) → one-click confirm → later browse the project thread or search "onboarding flows I saved" | M1, M4, M5, M6, M7 |
| UC3 | Marketing/competitor references | C, A | Capture ads, pricing pages, funnels as encountered → auto-OCR makes copy/prices searchable → routed to competitor/campaign thread → time-stamped trail of competitor changes | M1, M4, M5, M6, M7 |
| UC4 | Auto OCR everything | All | Zero user action: every capture gets ocr_text + summary + type + intent + why_saved from one cheap structured-JSON call within seconds of upload | M3, M5 |
| UC5 | Auto-organize everything | All | Zero folders ever created by hand: confidence ≥0.8 auto-assigns to a project (editable), 0.5–0.8 suggests on overlay, <0.5 lands in Inbox; corrections feed the few-shot learning loop so routing improves | M4, M5, M6, M9 |
| UC6 | Type-a-sentence retrieval + connected project conversations | All | Weeks later, type "the pricing page with the annual toggle" in the web app → semantic + OCR search returns it → open its project thread → ask follow-ups with full thread context ("draft a comparison against our pricing") | M7, M6, M8 |

### Use case notes for the implementation agent

- **UC1 is the emotional hook demo.** The overlay "Ask AI" path (locked decision 3) must feel instant: overlay within ~1s of capture, suggestion inline within ~3–5s, chat opens without waiting for classification to finish.
- **UC4/UC5 are background contracts, not screens.** Their UI footprint is only the overlay suggestion and the Inbox; the work is the pipeline (M5). If the pipeline is slow or flaky, UC6 silently dies — retrieval quality is downstream of ingestion reliability.
- **UC6 is the retention loop.** UC1–UC3 create supply; UC6 is the payoff that justifies the habit. The first "typed a sentence, found a 3-week-old screenshot" moment is the activation event worth instrumenting from day one.
- **Ignoring the overlay must be free.** Every use case assumes captures are never lost: no confirmation → Inbox (locked decision 3). Never block a capture on classification, network, or user attention.

## Assumptions

- A1: Personas B and C are validated only through the owner-user's own hats plus market intuition — no external interviews before MVP. Acceptable per personal-tool-first strategy (01_PRODUCT_BRIEF.md).
- A2: 15–50 captures/day per persona keeps AI cost at <US$0.50/day/user at the <US$0.01/capture target — comfortably inside a US$9/mo paid tier's margins.
- A3: All six use cases work single-player. Nothing here requires sharing, teams, or multi-user threads.

## Out of scope

- Persona expansion (students, researchers, support teams, agencies) — revisit only after customer-zero retention is proven.
- Persona-specific onboarding or templates — one product surface for all three; the classifier adapts via the learning loop, not via modes.
- Any team/collaboration flow — excluded outright in 04_MVP_SCOPE.md.
