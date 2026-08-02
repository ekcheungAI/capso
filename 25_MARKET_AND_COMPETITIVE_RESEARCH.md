# 25 — Market & Competitive Research

> Status: research, 2026-08-01. Siblings: 01_PRODUCT_BRIEF.md (positioning + competitor table this
> doc corrects), 03_PERSONAS_AND_USE_CASES.md (UC1–UC6, personas A/B/C), 04_MVP_SCOPE.md (the
> litmus test that governs every accept/reject below).
> Project root: `~/Desktop/ekOS/20_projects/Capso`
>
> **This doc records evidence and its provenance. It does not change scope.** Scope changes live in
> `04_MVP_SCOPE.md` Table 2; rejections are logged in `DEFERRED_LOG.md`.

## §0 — Evidence quality (read before trusting anything below)

Two inputs prompted this review. Neither is strong evidence, and the difference matters:

| Input | What it is | Weight |
|---|---|---|
| [r/PKMS: "Looking for a nice screenshot organizer (PicoJar alternative)"](https://www.reddit.com/r/PKMS/comments/1klkvrl/looking_for_a_nice_screenshot_organizer_picojar/) — 12 upvotes, 47 comments, posted ~1 year before this review | One real person enumerating requirements, plus ~8 substantive commenters | **Directional, not validating.** See caveats below |
| Owner-supplied persona/interview doc (Creator / Founder / Technical Builder) | Simulated interviews, AI-generated | **Hypothesis only.** Zero evidence of demand |
| Competitor research (§3) | **CleanShot X and mymind:** read directly from the vendors' own pages, 2026-08-01. **Apple and the auto-filer category:** secondary coverage and vendor comparison-marketing only | **Solid for the first two; indicative for the rest** (§3.3 warning). All of it perishable — re-check before any public positioning |

**Reddit caveats, stated plainly:**

- **The OP is not Capso's ICP.** They are an iPhone consumer organising a camera roll. Capso's
  customer zero is a Mac-first founder/marketer (`03_PERSONAS_AND_USE_CASES.md`, persona A). Their
  platform requirements must not be allowed to pull a Mac-first roadmap — see §5 rejections.
- **Roughly half the comment volume is one account** repeatedly promoting an Android APK. Real
  sample size is one OP plus ~8 commenters.
- **The thread is ~1 year old.** Some products named have since changed or died.

**Persona-doc caveat:** the interviews are simulated, not observed, and several of the document's
citations do not resolve to real sources. Nothing from it is recorded in this repo as a user
finding. It is used in §4 strictly as an idea generator.

**What this means:** the competitor corrections in §3 should be acted on. The Reddit findings in §2
should inform judgement, not override `04_MVP_SCOPE.md`.

## §1 — Headline conclusion

**Apple now owns the single-screenshot moment. Capso must own the accumulated corpus.**

As of iOS 26, Visual Intelligence operates on a screenshot: Highlight to Search, an "Ask" button
routed to ChatGPT, and Add to Calendar from a detected date. Spotlight indexes text inside images
and screenshots. All free, on-device, OS-integrated.

What Apple's model structurally does not do: it answers about *one* screenshot and forgets it. No
projects, no cross-capture synthesis, no longitudinal trail, no learning from corrections.

**Working test for every future roadmap item: "would Apple's per-screenshot Visual Intelligence
already do this?" If yes, don't build it.** By that test, Capso's defensible surface is exactly
UC3 (time-stamped competitor trails), UC5 (routing that learns from corrections), and UC6
(cross-capture retrieval and thread conversation) — all already in scope.

## §2 — The Reddit thread

### §2.1 The OP's requirements, in their stated order

Order preserved deliberately — the ranking is the finding, not the list.

| # | Requirement | Capso status |
|---|---|---|
| 1 | Recognise screenshots vs. the rest of the camera roll | N/A — Capso captures intentionally, never scans a library |
| 2 | Tags or folders | Rejected by design (`04_MVP_SCOPE.md:72`) |
| 3 | **Multiple** tags per screenshot | Partial gap — see §2.3 |
| 4 | Auto-delete organised screenshots from the phone | Rejected — see §5 |
| 5 | Grid / Pinterest-style view | Shipped (`apps/web/app/page.tsx`, gallery-first since Loop 23) |
| 6 | A place to see screenshots still without a tag | **Shipped** (`/inbox`, `/review`) — see §2.2 |
| 7 | Search by tag/folder | Partial (filters shipped; semantic search M7 not built) |
| 8 | iPhone + iPad, ideally also macOS or web | Deferred (`04_MVP_SCOPE.md:49`) |
| 9 | An app that is still maintained and updated | See §2.4 |
| 10 | *Nice to have:* import, not only export | Tripwire (`04_MVP_SCOPE.md:77`) |
| 11 | *Nice to have:* **smart searching or organising with AI** | Capso's entire thesis — ranked **last** |

Products the OP had already tried and rejected: Raindrop, Fabric, mymind, Eagle, Screenshot
Manager-Organizer, Screenshot PRO, Arrange, and PicoJar (which they describe as out of order).

### §2.2 Confirmed: the un-triaged inbox is a purchase criterion

The OP names it twice (#6, and again under search), and it is the specific reason they rejected
Fabric — they note Fabric has no folder showing items "yet to organise", alongside tagging that
didn't suit them and being "too complex and a bit too expensive".

Capso already ships `/inbox` (keyboard-first triage) and `/review` (post-import sweep). **Treat
these as differentiators to keep prominent, not as plumbing to hide.** This also independently
validates locked decision 3 (ignoring the overlay routes to Inbox, `03_PERSONAS_AND_USE_CASES.md:63`).

### §2.3 The uncomfortable finding: AI ranks last

The OP explicitly files "smart searching or organizing with AI" under **nice but not a must** —
below grid views and auto-delete. Capso's whole wedge is the memory layer.

Two readings:

- *Dismissible:* they are not the ICP. Partly fair.
- *Actionable, and the one to act on:* **intelligence is worthless on an unreliable mechanical
  layer.** Every product the OP rejected was rejected for mechanical reasons — tagging model, no
  un-triaged view, price, complexity — never for weak AI.

This maps directly onto Capso's current condition. Per the codebase state at Loop 23: the Chrome
extension has never been loaded in a real Chrome; `/api/ingest` holds captures in a module-scope
array on serverless and drops them; M1 Mac capture does not exist; the web app has no Supabase
client. **Ordering constraint for the roadmap: no new AI feature before capture-to-storage is
reliable.** This is consistent with the existing note at `03_PERSONAS_AND_USE_CASES.md:61` —
"retrieval quality is downstream of ingestion reliability".

### §2.4 The category is a graveyard, and buyers know it

PicoJar died, which is why the thread exists. The OP's requirement #9 is an app that is still
maintained. The alternatives surfaced in-thread are abandonware, a Microsoft-Store-only tool, or an
unreleased APK.

Cheap, disproportionate response: a public changelog before any external tester. Logged to
`04_MVP_SCOPE.md` Table 2.

### §2.5 "Screenshots as todos" — the richest insight in the thread

A commenter, replying to a since-removed comment that framed screenshots as todos, describes the
real shape of the problem: screenshots are *unprocessed intentions* — things to do, make, or learn
— and the backlog creates paralysis. They describe not knowing where in the camera roll to start,
so never starting, and the pile growing.

Capso's model is memory → retrieval. There is no "this one wanted something from me" affordance.

**Tension, stated rather than resolved:** `01_PRODUCT_BRIEF.md:73` names "no task lists" a
permanent non-goal, and `04_MVP_SCOPE.md:80` rejects a notes field. The narrow version that
respects both: the classifier already emits `intent`; a derived, non-editable `has_pending_action`
signal (OCR contains a date, deadline, price, or call-to-action) used **only** to rank the existing
Resurface shelf on `/memory`. No task list, no checkboxes, no due dates. **If it cannot be built
without those, it must not be built** — and note that Apple's Add to Calendar already covers the
single-screenshot version of this job (§1).

### §2.6 Local-first is an available position, currently held by accident

A commenter reports removing an app on sight of its signup screen, asking why an account is needed
for something that processes data on-device, and suggesting signup be optional if it only serves
sync. Two competitors (§3.3) already market on-device processing as their primary differentiator.

Capso is *accidentally* local-first today (IndexedDB, no auth) and plans to move to Supabase + Auth
(`19_BUILD_SEQUENCE.md` P0/P1). Making that a deliberate position — local-first by default, account
optional and only for sync — would also de-risk R3 (`18_RISKS_AND_OPEN_QUESTIONS.md`).

⚠️ **Blocking caveat, recorded so it is not lost:** Capso cannot make any public privacy claim while
`/api/classify` and `/api/chat` are unauthenticated on a public origin, and while the MiniMax key
and Supabase DB password remain unrotated after appearing in chat transcripts (all recorded in
`BUILD_LOG.md`). Fix before the claim, not after.

**This is an open owner decision, not a settled change** — see §6.

## §3 — Competitor teardown (all verified 2026-08-01)

### §3.1 The corrected table

This supersedes the table at `01_PRODUCT_BRIEF.md:61-66`, which overstated Capso's advantage in
three of four rows.

| Competitor | What it actually does now | What it still doesn't do | Capso's real wedge |
|---|---|---|---|
| **CleanShot X** ([features](https://cleanshot.com/features)) | On-device OCR (select an area, text to clipboard), CleanShot Cloud with shareable links incl. password + self-destruct, post-capture overlay, capture history, scrolling capture, **manual tagging for organisation** | **No search over past captures.** No AI classification, no routing, no memory, no conversation | OCR that *indexes for retrieval* rather than *extracts to clipboard*; a corpus you can query, not a history you can scroll |
| **mymind** ([pricing](https://access.mymind.com/pricing)) | AI image tagging, Image Text Recognition (search words inside images), Smart Spaces (automatic grouping), Serendipity resurfacing — all at **Student of Life, $7.99/mo**. AI Summaries + advanced AI at **Mastermind, $12.99/mo**. Entry Bookmarker tier $4.99/mo. **No free tier** | Not screenshot-native; no Mac capture tooling; no project threads; no chat *about* a saved item | Screenshot-first capture; project threads; conversational retrieval grounded in captures |
| **Auto-filer category** (§3.3) | A real and growing category, not a strawman | Flat smart-folders; no project context; no correction-learning; no conversation | Confirm-on-overlay routing + learning loop + thread chat |
| **Apple Screenshots + Spotlight + Visual Intelligence** ([iOS 26 guide](https://www.macrumors.com/guide/ios-26-visual-intelligence/), [Spotlight/OCR](https://zengo.eu/en/blog/apple-ocr-revolutionizing-text-recognition)) | Spotlight indexes text inside images/screenshots. Visual Intelligence on a screenshot: Highlight to Search, Ask (via ChatGPT), **Add to Calendar from a detected date** | Single-screenshot only. No projects, no cross-capture synthesis, no longitudinal trail, no learning | **The corpus, not the moment** (§1) |

**Verification depth differs by row and this matters.** CleanShot X and mymind were read directly
from the vendors' own pages. The Apple and auto-filer rows rest on secondary coverage (§3.3) and
should be confirmed first-hand before any public claim is made against them.

### §3.2 Corrections against what the brief previously claimed

| Brief's claim | Verdict | Correction |
|---|---|---|
| CleanShot X: "No OCR search, no AI, no organization, no memory" | **Wrong on two counts** | It has OCR, and it has manual tagging + capture history. Accurate statement: no *search* over captures, and no AI. The vendor's own features page confirms no search |
| Apple: "retrieval limited to literal text" | **Wrong** | Visual Intelligence answers questions about a screenshot and extracts calendar events. Free, on-device, OS-level |
| mymind: "no AI chat about saved items, not screenshot-native" | **Still accurate** | But it now has AI tagging, image text recognition, automatic grouping and resurfacing — much closer to Capso than the brief implies |
| ShotSnap-style: "auto-tagging into a flat gallery is organization theater" | **Positioning claim, not a moat** | The category has grown and two entrants compete on privacy — see §3.3 |

### §3.3 The auto-filer category has grown

The brief's single generic row understates this. Scanned 2026-08-01.

⚠️ **Source-quality warning:** much of the material here is vendor-authored comparison marketing —
Pizazoo's page compares Pizazoo to ShotSnap, Sorti's compares Sorti to mymind. Each vendor's claims
about *itself* are reasonably reliable; its claims about *rivals* are not. Treat the table as a map
of who exists and how they position, **not** as verified feature facts. Confirm first-hand before
using any of it in positioning.

| Product | Position (as the vendor states it) | Why it matters to Capso |
|---|---|---|
| [ShotSnap](https://www.shotsnap.ai/shotsnap-vs-screensnap-ai) | GPT-4V, smart folders, Mac, ~$6/mo | The closest analogue to Capso's ingestion pipeline, cheaper |
| [Pizazoo](https://pizazoo.com/compare/shotsnap/) | 100% on-device, free tier, explicitly positioned *against* ShotSnap's cloud | Competes on the exact axis §2.6 shows users react to |
| [SnapStash](https://www.snapstash.app/blog/best-screenshot-organizer-app-iphone) | iOS, on-device OCR + search | Same, on the platform Capso doesn't serve |
| [ScreenDrafter](https://screendrafter.com/blog/shottr-alternative-mac/) | On-device AI **filenames** | Attacks a pain the brief never names — Capso's captures have no meaningful filename either |
| [Sorti](https://letitsorti.com/journal/best-app-to-organize-screenshots-iphone-android), [Filex AI](https://filexai.com/blog/best-screenshot-organizer-iphone), [MarkIt](https://mark-it.co/screenshot-organizer-app) | Cross-platform organisers, semantic search, free tiers | Price and platform pressure |
| Smart Screenshot Manager | Microsoft Store only | Surfaced in-thread; irrelevant to a Mac-first product |

**Implication:** "organization theater" remains a defensible *argument*, but it is not a moat. What
none of them do is project routing that learns from corrections, plus conversation over the corpus.
That, not auto-tagging, is what must be excellent.

### §3.4 Pricing pressure

Capso's planned free + ~US$9/mo AI tier (`16_PRICING_AND_PACKAGING.md`) is squeezed harder than the
brief assumed: mymind ships AI tagging, image text recognition, automatic grouping *and*
resurfacing at **$7.99**, and ShotSnap ships AI filing at **~$6**. Several auto-filers have free
tiers; mymind has none.

This is not a call to change pricing — it is a note that ~US$9 is no longer obviously
under-priced, and the tier's justification has to be the thread/chat/learning layer, not AI-per-se.

## §4 — Persona document (hypothesis only)

Per §0, the supplied personas are simulated. Two ideas survive the `04_MVP_SCOPE.md` litmus test,
both cheap because the plumbing exists, and both things Apple's per-screenshot model cannot do:

- **Source URL / app as classifier signal.** The Chrome extension already captures the tab URL
  (`apps/extension/popup.js` displays it) and Capso **currently discards it**. Feeding hostname into
  `/api/classify` is a high-precision accuracy win that *reduces* dependence on the vision model.
  Cheapest win identified in this review. Serves UC2, UC3 / J3.
- **Session / flow grouping.** Several captures from one browsing session or domain kept linked as a
  sequence. Serves UC3 (competitor funnel steps, already specced) and is longitudinal structure
  Apple has no answer for. Serves UC3 / J6.

Everything else from the document is rejected in §5.

## §5 — Rejected, with reasons

Recorded here and in `DEFERRED_LOG.md` so these do not resurface as fresh ideas.

| Idea | Source | Why rejected |
|---|---|---|
| iOS / mobile capture app | Reddit OP's platform | Already deferred (`04_MVP_SCOPE.md:49`). **This thread is not the trigger** — the OP is a different persona from customer zero. Do not let an iPhone consumer's requirements pull a Mac-first roadmap |
| Auto-delete originals after filing | Reddit req #4 | Camera-roll hygiene, not memory-loop value; fails the litmus test (`04_MVP_SCOPE.md:8`). Destructive by default, against the trust posture |
| Batch-import the screenshot backlog | Reddit §2.5 paralysis | Explicit tripwire (`04_MVP_SCOPE.md:77`). The paralysis is real; the fix is resurfacing, not import |
| Tags/folders alongside projects | Reddit req #2 | Stays rejected (`04_MVP_SCOPE.md:72`). Multi-project membership (§2.3, Table 2) is a different and narrower change |
| Push to Linear/Jira; snippet export to dev tools | Persona 3 | Violates the "not a dev-only screenshot pipe" non-goal (`01_PRODUCT_BRIEF.md:74`) |
| Contextual recall inside Notion/Figma while working | Persona 2 | Genuinely valuable, and a different product. Revisit post-PMF only |
| Pattern decks / incident episodes as new surfaces | Personas 2, 3 | These are project threads (M6) relabelled. Build nothing new |
| Metric-aware structured search ("RPM > X") | Persona 1 | Speculative; needs real dashboard-capture data before it can be designed |

## §6 — Open decision for the owner

**Does local-first become a stated position (§2.6), or stay an implementation detail?**

It is the only recommendation in this review that would change `01_PRODUCT_BRIEF.md`'s non-goals and
constrain the planned Supabase Auth work (`19_BUILD_SEQUENCE.md` P0/P1). It is therefore **not
written into the brief's positioning** — this section is the record that it was raised and left
open. Everything else from this review is either a factual correction (§3) or an additive,
reversible Table 2 deferral.

Related open questions already logged: Q2 (embedding provider), Q4 (distribution), Q5 (first
external testers) in `18_RISKS_AND_OPEN_QUESTIONS.md`.
