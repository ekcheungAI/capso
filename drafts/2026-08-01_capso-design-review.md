# Capso — design review

**Date:** 2026-08-01
**Scope:** Part 1 — product UX, search & intent mapping, AI understanding, background loops, recall surfaces. Part 2 — capture UX benchmarked against CleanShot X (extension + Mac + web).
**Basis:** the repository at `~/Desktop/ekOS/20_projects/Capso` at commit `9767dbe`, not a description of it.
**Status:** advisory. Nothing here is a locked decision until it lands in the numbered docs.

---

## Part 0 — What was actually reviewed, and four corrections

Both briefs promised inputs — sitemaps, screenshots, schema dumps, a description of the capture
flow — that were not supplied. Reviewing the codebase directly turned out to be better: it
surfaced four facts that change what the briefs are asking for.

**0.1 — There is no landing page.** `apps/web/app/page.tsx` is the authenticated library. There is
no unauthenticated surface, no pricing page, no signup, no auth at all. The only marketing copy
in the repository is OpenGraph metadata in `apps/web/app/layout.tsx:28-41` — headline *"You're
not organised. Capso is."* and description *"Every screenshot read, filed, and findable by a
sentence."* Both are good. Neither is on a page. Section A audits the app; the landing page is a
build item, not an audit item.

**0.2 — There is no Mac app.** `apps/mac/src/App.tsx` is fifteen lines that render *"Menu-bar
shell running."* The Tauri side (`src-tauri/src/lib.rs`) is a tray toggle and a Quit menu. It
captures nothing, sends nothing, and requests no permissions. Every Mac capability the planning
docs attribute to it — `hotkey_region`, `hotkey_window`, `sourceApp`, `apple_vision` — is a
reserved enum value with no producer anywhere in the source. Part 2's Mac sections are therefore
a greenfield specification, marked as such, not a critique.

**0.3 — There is no semantic search and no background processing.** `apps/web/lib/retrieve.ts` is
weighted substring matching over an in-memory array. Classification is a single blocking call on
the client (`apps/web/components/capture.tsx:91`), and bulk imports run sequentially
(`capture.tsx:160`). The Postgres schema anticipates embeddings — `vector(1536)`, an HNSW index,
a `search_tsv` GIN index — and nothing writes to any of them.

**0.4 — "Capsules" and "racks" do not exist in the product.** The type layer says `Screenshot`
and `Thread`. The URL says `/threads/[id]`. The UI says "capture", "project" and "shelf". The SQL
table is `project_threads`. That is already three names for one concept.

> **Recommendation (Part 0):** keep the capsule metaphor where it is already working — the mark,
> the marketing register, the brand guidelines — and do **not** rename anything in-product. A
> fourth name for `Thread` makes the codebase worse and buys the user nothing; "project" is the
> word they already think in. The metaphor's job is to make the *mark* legible and the marketing
> ownable, and `drafts/brand/GUIDELINES.html` already does that job well. Where this review uses
> "capsule" it means the brand-facing name for a capture; the code should not follow.

A fifth observation that frames everything below: this codebase has unusually good judgment
recorded in it. `retrieve.ts:38-47` explains why the length filter is Latin-only. `classify.ts:5-17`
explains why a failed classification writes nothing rather than something. `globals.css` opens
by explaining why there is no accent colour. Several findings below are the codebase's own
stated intentions that have not been executed yet — those are the cheapest wins in the document,
because the argument is already won.

---

# Part 1 — Product, search, AI, loops, recall

## §A — UX/UI and feature audit

### A.1 Overall assessment

1. **The product's craft floor is high and its coverage floor is low.** Individual surfaces are
   better than most funded products — honest failure states, undo on every destructive path,
   `prefers-reduced-motion` handled, provenance visible on every AI decision. But whole
   categories are simply absent: no mobile navigation, no landing page, no annotation, no
   keyboard-shortcut reference, no focus-visible styling. The gap is not quality, it is surface
   area.

2. **The filing loop is over-served and the retrieval loop is under-served.** There are four
   surfaces for deciding where a capture goes — Inbox, Review, the card confirm chip, and the
   post-capture overlay — with three different verb sets between them. There is one surface for
   getting something back out, and its ranking is substring matching. `17_METRICS_AND_ANALYTICS.md`
   names the north star as *successful retrievals of old screenshots per week*. The build has
   optimised the input side of that metric.

3. **"Quiet order" is working, and it is one decision away from being under-powered.** Removing
   the accent colour was right, and the reasoning in `globals.css` is correct: any brand hue
   loses against arbitrary captured pixels. But the consequence is that *every* control now has
   the same visual weight as every other control. The product needs a second axis of emphasis
   that is not colour. `GUIDELINES.html` already supplies it — the mark, and the provenance rule
   that the mark means Capso decided. It is specified and not built.

4. **The system learns and never shows the user that it learned.** `assignThread`
   (`lib/store/index.ts:208`) writes a `Correction` on every accept *and* every override; the
   most recent 20 project corrections feed the classifier's few-shot window
   (`lib/classify.ts:102`). `/memory` renders this beautifully. It is a tab three clicks deep
   that a user visits approximately never. The single best activation move in the product is
   promoting one line of it to the home page.

5. **Several settled decisions are unexecuted.** The Notion Mail three-verb vocabulary
   (`15_DESIGN_SYSTEM_AND_UX.md:140`), the resurfacing shelf with its mandatory reason line
   (`GUIDELINES.html`), the removable filter pill for extracted dates
   (`15_DESIGN_SYSTEM_AND_UX.md:160`). These are not new ideas needing debate — they are backlog.

### A.2 Per-surface findings

Each issue is paired with its fix. Severity: **P0** blocks daily use · **P1** materially degrades
it · **P2** polish.

#### Library — `/` (`apps/web/app/page.tsx`)

| # | Issue | Fix |
|---|---|---|
| A1 **P0** | The sidebar is `hidden … md:block` (`shell.tsx:77`) with nothing replacing it below 768px. Inbox, Search, Memory, project switching and "+ New project" are all unreachable on a phone. The ⌘K palette is the only navigation left and it needs a keyboard. | Bottom bar below `md` with four destinations (Library, Inbox, Search, Memory) plus a capture affordance. The projects list becomes a sheet. This is not a mobile app — it is making the desktop app not break. |
| A2 **P1** | `shelfOf = s.threadId ?? s.suggestedThreadId ?? null` (`page.tsx:63`) is a genuinely good idea — unconfirmed captures render in the shelf they are headed for. But a shelf can therefore contain items the user never approved, distinguished only by a dashed ring and an "N to confirm" pill. | Keep the mechanic. Add one muted line under a shelf heading when it contains guesses: *"3 of these are guesses."* The dashed ring carries the per-card signal; the shelf needs the aggregate. |
| A3 **P1** | Three filters, a grouping segmented control, a reset link and a counter sit above the grid at all times, including when there are twelve captures. High chrome-to-content ratio on exactly the screen that is supposed to let screenshots be the hero. | Collapse the filter row to a single "Filter" affordance until a filter is active or the library exceeds ~40 captures. Applied filters echo back as removable pills — already the decided pattern (`15:160`). |
| A4 **P2** | The `<h1>` is `sr-only` (`page.tsx:137`). The page has no visible title and no visible search field of its own. | The mymind reference the doc itself cites (`15:132`) puts an oversized ghost search input where the page title would be. That is the right move here and it fixes A3's emphasis problem at the same time. |

#### Inbox — `/inbox`

| # | Issue | Fix |
|---|---|---|
| A5 **P1** | Verbs are Confirm / Change project… / Try again. Review says ✓ Keep in {x} / Somewhere else…. The card chip says ✓ Keep here / Change. Same `assignThread()` call, three vocabularies. | Execute the decision already recorded at `15:140`: **Accept / Discard / Try again** everywhere. "Try again" is the cheap escape hatch that stops a wrong guess feeling like a dead end. |
| A6 **P1** | The shortcut legend "j/k move · ⏎ accept · 1–{n} pick project" appears only here and on `/review`. There is no global shortcut reference. ⌘K is discoverable via the header `kbd`; nothing else is. | A `?` overlay listing every binding, as `drafts/UI_AND_BRAND_PLAN.md` proposes. Cheap, and it makes the keyboard-first design legible instead of secret. |
| A7 **P2** | Confirm is `disabled` without a suggestion (`inbox/page.tsx:132`) — correct, since it used to teach the model to file into Inbox. But a disabled button with no explanation reads as broken. | Replace the disabled button with the reason: *"No guess — pick a project."* One line, and the select next to it becomes the obvious action. |

#### Review — `/review`

| # | Issue | Fix |
|---|---|---|
| A8 **P0** | The screen is not in the navigation. It is reachable only from a banner gated at `inbox.length >= 3` (`page.tsx:144`) and an import toast gated at `landed >= 3` (`capture.tsx:179`). With two pending suggestions the sweep is unreachable, and once the toast is dismissed there is no way back. | Put it in the sidebar. Remove the `>= 3` gate — a two-item sweep is still a sweep, and the momentum argument in `review/page.tsx:33-47` (most-confident-first) applies at any size. |
| A9 — | *Not an issue — worth preserving.* Sorting most-confident-first so the run of easy yeses builds momentum, and one undo toast for the whole batch rather than N, is the best interaction design in the product. Any redesign keeps it. | — |

#### Search — `/search`

| # | Issue | Fix |
|---|---|---|
| A10 **P0** | Two different search engines. `retrieve()` (`lib/retrieve.ts:75`) is weighted across ten fields with CJK segmentation. The ⌘K palette (`components/palette.tsx:30-42`) has its own inline unranked AND-of-substrings over six fields, with no `Intl.Segmenter`, no `userTags`, no `pageTitle`. The palette is the surface users actually hit, and it is the weaker engine. A 繁體中文 query that works on `/search` returns nothing in ⌘K. | Delete the inline filter; call `retrieve()`. One engine. |
| A11 **P1** | The page has no heading at all, and the mode split (type = filter, Enter = ask) is undocumented in the UI. The four example chips vanish the moment a character is typed, which is exactly when the affordance is still needed. | Persist the mode hint next to the input: *"Type to filter · ⏎ to ask."* Keep one example chip row visible until the first successful search. |
| A12 **P1** | `"the pricing page I saved in March"` — one of the product's own seeded examples (`search/page.tsx:10-15`) — has no date handling. `08_FEATURE_SPEC_SEARCH_AND_RETRIEVAL.md` §3 specifies deterministic NL date extraction with a removable pill. Not built. The product ships an example query it cannot answer well. | Build the date extractor (§B.4 below). Until then, change the example. |
| A13 **P2** | Failure copy names an environment variable: *"Answering needs MINIMAX_TEXT_API_KEY."* `/threads/[id]` names it too, differently. The sidebar says "AI: sample data". Three phrasings, one condition. | One string, no env var: *"Answers are off — results below are real."* The env-var name belongs in a `title` or the console, per `15:29` ("no error-code language at the surface"). |

#### Memory — `/memory`

| # | Issue | Fix |
|---|---|---|
| A14 **P1** | This is the product's differentiator and it is buried. The acceptance rate, the learned rules, the resurfacing candidates — all of it is three clicks from the work surface and none of it is ever pushed. | Promote exactly two things to `/`: the resurfacing shelf (A15) and one learned-rule line in the ledger strip. Not a dashboard — `24_FEATURE_SPEC_MEMORY.md` is explicit that this is a ledger, and one line respects that. |
| A15 **P0** | The resurfacing shelf is fully specified in `GUIDELINES.html` — its own shelf on home above the projects, a mandatory reason line per capture, *"No badge, no count, no red dot"*, empty most days and that being fine. `/memory` already computes the candidates. It is not built. | Build it. This is the single highest-leverage item in Part 1: it converts a storage product into a memory product, and both the spec and the data exist. |
| A16 **P2** | Duplicate detection is an O(n²) shared-title-word heuristic (`memory/page.tsx:193-207`) on a `contentHash` field that exists in the type and is never written. It will produce false positives at any real library size. | Write `contentHash` at ingest. Exact-duplicate detection becomes correct and free; the heuristic becomes a separate "similar" feature or goes away. |

#### Capture detail — `/s/[id]`

| # | Issue | Fix |
|---|---|---|
| A17 — | *Worth preserving.* The lazy full-image fetch falling back to the 800px thumb so the page is never empty (`s/[id]/page.tsx:40-60`), the AI-vs-owner tag legend, click-to-edit `whySaved`. This screen is right. | — |
| A18 **P2** | "Why I saved this" is the highest-value field in the row — it is weighted 3 in retrieval and it is the only place the user's actual reasoning lives — and it is a click-to-reveal textarea below the fold of the sidebar. | Promote it. When empty, it is the one prompt on the screen: *"Why did you save this?"* Every filled one measurably improves retrieval. |

#### First run — `components/first-run.tsx`

| # | Issue | Fix |
|---|---|---|
| A19 — | *Worth preserving.* Listing the projects each role card would create — *"a promise you can read beats a promise you have to accept blind"* — is exactly right, as is honestly labelling sample data everywhere it appears. | — |
| A20 **P1** | `15:78` says the onboarding finale is the product doing its trick — press the hotkey, watch it classify live. There is no hotkey; the "Capture" button generates a synthetic canvas image. A first-run user's first capture is fake. | Until the Mac app exists, make the first real action a **drop or paste**, and say so: *"Drop a screenshot here."* Real image, real classification, real 3.9s wait, real result. The synthetic sample stays available as "Explore with sample captures", which is already honest. |

#### Cross-cutting

| # | Issue | Fix |
|---|---|---|
| A21 **P1** | `EmptyState`'s `action` renders as static accent text (`ui.tsx:389-394`). Eight call sites offer what reads as a link and is not one. `/review` works around it by adding a real link underneath. | Change the prop to `ReactNode`. Eight surfaces become actionable in one edit. |
| A22 **P1** | Focus-visible styling is essentially absent — one explicit ring in the app (`palette.tsx:91`). Two interactive elements are `opacity-0` until hover. For a product whose core triage flow is keyboard-first, the keyboard is invisible. | One `:focus-visible` ring token applied globally; make the hover-revealed controls appear on focus too. |
| A23 **P2** | Five destructive confirmations use native `confirm()`. On a product this carefully art-directed, a system dialog is the one moment the illusion breaks. | One styled confirm component. Low effort, disproportionate perceived-quality return. |
| A24 **P2** | `FilterPill` (`ui.tsx:62`) is exported and imported nowhere. | Delete it — or better, use it: it is exactly the removable applied-filter pill that A3 and A12 both need. |
| A25 **P2** | `15_DESIGN_SYSTEM_AND_UX.md:36` mandates a *"Single accent color"*; the token table at line 112 says `Accent | None.` The brand work settled on none. | Edit line 36, and record the reversal in the doc rather than silently — the repo's own norm (`BUILD_LOG.md` Loop 12a). |

### A.3 Top five feature ideas

Ranked by impact ÷ effort. Each is tied to the metaphor as `GUIDELINES.html` defines it, not
decoratively.

**1. The resurfacing shelf** *(quick win)*
One shelf on `/`, above the projects. Three to five captures Capso thinks are worth seeing today,
each with a mandatory one-line reason: *"Saved in March, never opened, and you searched for
pricing twice this week."* Empty most days.
*Why it matters:* it is the difference between a filing cabinet and a memory. It is also the
north-star metric made visible.
*Metaphor fit:* `GUIDELINES.html` — *"The rack holds everything. Capso knows which one to pull."*
The shelf is the second clause of the brand promise, and it is currently unbuilt.

**2. "Why I saved this" as a first-class prompt** *(quick win)*
Promote the field, prompt for it when empty, and let it be answered from the post-capture overlay
in one line without leaving the page.
*Why it matters:* it is the single strongest retrieval signal (weight 3, and the only field
containing the user's actual reasoning). It is also the field the AI is forbidden to overwrite
(`capture.tsx:137`), which makes it the trust anchor of the whole classification story.
*Metaphor fit:* the note is what you seal into the capsule alongside the image.

**3. Stacks — an ad-hoc grouping that is not a project** *(next iteration)*
Select several captures → "Make a stack". A stack has a name, an optional question, and lives on
the library as a shelf. Unlike a project it is disposable and does not enter the classifier's
candidate list.
*Why it matters:* projects are long-lived and the classifier depends on their stability, so users
correctly hesitate to create them for a two-day investigation. Stacks absorb that pressure
without polluting the taxonomy.
*Metaphor fit:* a handful of capsules pulled from the rack and set on the counter together.
*Constraint:* one level, no nesting, ever (`15:99`).

**4. Time-lane view** *(next iteration)*
A third grouping alongside project and month: the same *idea* over time. "Pricing page" as it
appeared in March, May and July, on one horizontal lane.
*Why it matters:* it answers a question no competitor answers — *how did this evolve* — and it is
the visible payoff of the clustering work in §C.3.
*Metaphor fit:* the time-capsule reading, which `BRAND_PLATFORM.md` names as one of the three
deliberate ambiguities.

**5. Sensitive-capture handling** *(next iteration)*
Detect likely secrets at classify time (API-key shapes, `password`/`token` labels, bank-card
patterns), flag the capture, hold it out of the search index until the user confirms, and offer
one-tap blur.
*Why it matters:* `18_RISKS_AND_OPEN_QUESTIONS.md` R3 names screenshots-contain-secrets as a top
risk and nothing addresses it. For a build-in-public product this is also the credibility story.
*Metaphor fit:* a sealed capsule is only trustworthy if you know what got sealed in.

---

## §B — Search and intent mapping

### B.1 Model of user search intents

Derived from what a user *retains* about a screenshot they took months ago. Each intent lists
what the user supplies, and whether Capso can serve it today.

| # | Intent | Example | Signal the user supplies | Today |
|---|---|---|---|---|
| I1 | **Temporal** | "that idea from last summer" · "the pricing page I saved in March" | A fuzzy date range, usually nothing else | ❌ No date extraction. The words go into the term bag and match nothing. |
| I2 | **Source / app** | "the screenshot from Notion" · "that GitHub issue" | An application or domain | ◐ Only for extension captures — `pageUrl`/`pageTitle` are populated there. `sourceApp` is reserved and never written. |
| I3 | **Textual fragment** | "something about 'capsule search pipeline'" | A remembered phrase, often misremembered | ◐ OCR text is searched at weight 2, but substring-only: a paraphrase fails, and "cat" matches "category". |
| I4 | **Visual structure** | "the whiteboard with sticky notes" · "the one with the pricing table" | A description of layout, not content | ❌ Nothing. `type` exists (8 values) but is not surfaced as a filter and has no visual vocabulary. |
| I5 | **Semantic / thematic** | "good mobile UI designs" | A concept, no literal words in common with the capture | ◐ Reaches via the intent *label* only — deliberate and clever (`retrieve.ts:6-7`), but it is one hop, not semantics. |
| I6 | **Project-scoped** | "in the launch campaign, the one about hooks" | A project plus a fragment | ✅ Works — `/threads/[id]` ranks in-project first then spills (`threads/[id]/page.tsx:52-66`). |
| I7 | **Return-to** | "the one I keep coming back to" | Nothing but their own history | ❌ `revisits` is populated on four event kinds and consumed only by the resurface tab. |
| I8 | **Negative / process** | "what did I decide about pricing?" | A question, not a lookup | ◐ This is the Ask mode, and it works — but only over whatever the substring retriever handed it. |

**The shape of the gap:** the two intents users lead with most often — I1 temporal and I4 visual —
are the two with no implementation at all, and I7 has its data collected and thrown away.

### B.2 Proposed architecture

The seam is already correct. `retrieve.ts:9` states it: *"P1 replaces the body with pgvector +
tsvector; the signature stays."* Nothing below changes `retrieve(query, screenshots, threads, limit)`
as seen by callers.

```
QUERY
  │
  ├─► PARSE (deterministic, client, <1ms — never an LLM call, per 08 §3)
  │     ├─ date extraction ──────► { from, to } ──┐
  │     ├─ source extraction ────► { domain|app } ─┤  structured filters,
  │     ├─ intent-word match ────► { intent }  ────┤  each rendered as a
  │     └─ residual text ────────► free terms  ────┘  REMOVABLE PILL
  │
  ├─► CANDIDATES (three retrievers, run in parallel, union)
  │     ├─ KEYWORD    tsvector over search_text (Intl.Segmenter-tokenised,
  │     │             `simple` config — hosted Supabase has no zhparser)
  │     ├─ SEMANTIC   pgvector HNSW cosine, top 50
  │     └─ STRUCTURED rows matching the extracted filters (may be the whole
  │                   result when the query is purely temporal — "last summer"
  │                   has no text at all after parsing)
  │
  ├─► FUSE (the formula is already specified — 08 §5)
  │     0.55 · semantic
  │   + 0.25 · keyword
  │   + 0.10 · recency        exp(-age_days / 90)
  │   + 0.10 · revisit        log1p(revisit_count), normalised
  │     × structured filter mask (hard, not a weight — "March" means March)
  │
  └─► EXPLAIN
        every result carries `why` — already built (`retrieve.ts:121`) and
        already rendered ("matched on title + summary"). Keep it. It is the
        cheapest trust mechanism in the product.
```

**Three notes on this that are not obvious:**

- **The structured filter is a mask, not a weight.** If a user says "March", a brilliant semantic
  match from July is wrong, not merely lower-ranked. The removable pill is what makes this
  reversible, which is why the pill is a requirement and not a nicety.
- **The revisit term needs no new data.** `Revisit` rows already exist with four kinds. Weighting
  `search_clicked` above `opened_detail` gives implicit relevance feedback for free — the user
  clicking a result for a query *is* the training signal.
- **`terms()` must be shared between query time and write time.** `retrieve.ts:48-50` already
  says this. If the tsvector column is tokenised differently from the query, CJK recall silently
  collapses, and Loop 12b's fix (競品 going 0 → 1 result) regresses without a test catching it.

### B.3 UI patterns

**Search bar.** One box, two modes, per `search/page.tsx:17-21` — *"Search is an agent over your
memory, not a filter box."* That is right. Make the split legible: type filters live, `⏎` asks.
Follow the mymind mechanic the design doc already adopted (`15:132`) and make the input oversized,
sitting where a page title would.

**Parsed filters as pills.** When "pricing page from March" is typed, a `March 2026 ×` pill
appears next to the input and the residual query becomes "pricing page". This is the decided
pattern (`15:160`, GoFundMe/Unity references) and it does three jobs: shows the system understood,
makes the interpretation reversible, and teaches the syntax by demonstration.

**Result grouping.** Default flat by relevance. Offer *by time* (date-group headers between rows,
per the Fabric reference) and *by project*. Do not offer more — `15:163` sets the tripwire: three
filters, a fourth only when a real query fails without it.

**Intent chip row** under the field for one-tap refinement (Pinterest mechanic, `15:161`). Seven
intents, horizontally scrollable, using the existing `INTENT_COLOR` dots.

**Empty results** must say what was searched, which the current copy already does well:
*"Capso searches titles, summaries, your own notes, the text inside each image, and the intent it
assigned."* Keep verbatim.

### B.4 Five concrete recommendations

1. **Consolidate the palette onto `retrieve()`.** One engine. Deletes a class of "works here, not
   there" bugs permanently, including the CJK divergence. *One afternoon.*
2. **Fix the scoring function.** Three defects, all in `retrieve.ts`:
   - `hay.includes(w)` (line 110) matches inside words. Use prefix-or-boundary matching, keeping
     substring behaviour for CJK where it is correct.
   - `.filter(x => x.score > 2)` (line 123) is numerically identical to the maximum recency bonus
     (line 119). The threshold works by coincidence and will break the moment either constant
     moves. Separate them: gate on term hits, then rank.
   - An N-word query adds N×weight within a single field, so a verbose query over-rewards one
     long OCR blob. Cap per-field contribution.
3. **Wire in the revisit term.** The table is populated, the weight is specified, the consumer is
   missing. This makes I7 work and improves every other intent. *A few hours.*
4. **Build deterministic date extraction** with the removable pill. Handles "March", "last
   summer", "3 weeks ago", "before the launch" (against project `createdAt`). No LLM call — 08 §3
   is explicit and correct: a model call here adds latency and non-determinism to a problem regex
   solves.
5. **Surface `type` as the visual-structure filter (I4).** The field is populated by the
   classifier today and shown nowhere. `ui_screen / chart / code / document / photo` is most of
   what a user means by "the one with the table". Zero pipeline work — it is already in the row.

---

## §C — AI understanding of screenshots

### C.1 Per-capture pipeline

Today: one blocking multimodal call returning eight fields, then a functional patch. That call is
good — the prompt at `apps/web/app/api/classify/route.ts:22-61` is well constructed, the
injection fencing at `:113-127` is correct, and the calibration instruction *"Do not default to
the middle band"* is the kind of detail most teams miss. The problem is that it is **one stage
doing five jobs, synchronously, on the client.**

Proposed split. Stage 0 stays synchronous; everything else moves behind the queue.

| Stage | When | Input | Output | Storage | Latency budget |
|---|---|---|---|---|---|
| **0 · Intake** | Sync, on capture | Raw image | Downscaled original (≤1600 JPEG) + 800px WebP thumb + `width`/`height` + **`contentHash`** | `images` / `screenshots` | <300ms, never blocks |
| **1 · Read** | Async, ≤5s p50 | Thumb + page context | `ocr_text`, `type`, `title` | `screenshots` | The existing call, minus the fields below |
| **2 · Interpret** | Async, after 1 | Stage-1 output + project descriptions + few-shot corrections | `summary`, `intent`, `project_suggestion`, `confidence`, `why_saved`, `tags` | `screenshots` | Text-only — cheaper and faster than re-sending the image |
| **3 · Embed** | Async, after 2 | `title` + `summary` + `ocr_text` + tags, and the image | `text_embedding`, `image_embedding` | `screenshots.embedding` | Batched |
| **4 · Index** | Async, after 2 | Same fields via `terms()` | `search_text`, `search_tsv` | `screenshots` | Trivial |
| **5 · Relate** | Nightly / on threshold | Embeddings across the library | cluster ids, near-duplicate links, time-lane membership | new `capture_clusters` | Batch |

**Why split 1 from 2.** OCR and type detection depend only on pixels. Everything in stage 2
depends on the *user's* context — their projects, their correction history — which changes
constantly. Splitting means a re-classification after the user renames a project or files a
correction is a cheap text call, not a re-upload of the image. It also means stage 1's output is
cacheable against `contentHash`: the same screenshot captured twice is read once.

**Why `contentHash` moves to stage 0.** It is already in the type and never written. Computed at
intake it gives exact-duplicate detection for free, retires the O(n²) heuristic in
`memory/page.tsx:193-207`, and lets stage 1 skip work entirely on a re-capture.

### C.2 Recommended techniques

Conceptual, no library commitments.

- **OCR.** Keep it in the vision model. A dedicated engine would be faster and cheaper, but Loop
  05–06 verified 繁體中文 comes back verbatim and correct, and `ocrSource` already anticipates
  swapping later. Do not re-litigate a working decision to save a few cents.
- **Layout.** Ask stage 1 for coarse structure — a short list of regions with kind and rough
  bbox (`nav`, `table`, `chart`, `code_block`, `form`). Not pixel-accurate segmentation. It is
  what powers I4 visual search and, later, region-of-interest crops.
- **Embeddings — two vectors, not one.** A text embedding over `title + summary + ocr_text + tags`
  and an image embedding from a joint image–text model. Query both, take the max per capture.
  Reason: the two intents fail in opposite directions. "The whiteboard with sticky notes" has no
  useful text; "capsule search pipeline" is entirely text and visually generic. One fused vector
  is worse than two queried in parallel. The schema's single `vector(1536)` column needs a
  sibling — cheaper to change now than after backfill.
- **Tags.** Keep the two-tier split exactly as built. The model writes `tags`, never `userTags`
  (`capture.tsx:99-140`), and removing an AI tag writes a correction while adding a user tag does
  not (`store/index.ts:266-306`) — *"the owner is volunteering information, not disagreeing with a
  guess."* That distinction is subtle, correct, and worth protecting in code review.
- **Clustering.** Incremental, not global. New capture → nearest-neighbour against existing
  centroids → join if within threshold, else provisional cluster. A nightly job re-fits. Global
  re-clustering on every insert is both expensive and *user-hostile*: groupings that reshuffle
  overnight destroy the spatial memory the library depends on.

### C.3 Automatic tagging and clustering with minimal friction

The correction ledger is the mechanism and it already works. Three additions:

1. **Cluster naming is a suggestion, never a mutation.** A cluster that reaches ~5 members earns
   one line on the library: *"5 captures look like one idea — name it?"* Dismissible, and staying
   dismissed. This is principle 3 of `15:22` applied to grouping.
2. **Corrections should propagate.** Moving a capture out of a wrong project should offer *"Move
   the other 4 like it?"* — one prompt, undoable as a batch. One correction currently teaches the
   next classification; it should also fix the past.
3. **Confidence bands stay as built.** `AUTO_ASSIGN_MIN = 0.8`, `SUGGEST_MIN = 0.5`. The
   acceptance-rate stat on `/memory` is the instrument for tuning them. Do not move them on
   intuition — move them when the ledger says to.

### C.4 What this buys

| Layer | Enables |
|---|---|
| Per-image | I3 fragment · I4 visual structure (via `type` + regions) · better titles |
| Embeddings | I5 semantic — the intent that currently works by a single label hop |
| Clustering | Stacks that build themselves · "similar capsules" on the detail page · the duplicate tidy-up that actually works |
| Time-series | The time-lane view · resurfacing reasons that cite evolution rather than just age |
| Correction ledger | Ranking personalisation · project suggestions that improve measurably, which is the promise `/memory` already makes |

---

## §D — Background processing and loop engineering

### D.1 The jobs

Nothing here can run before the store migration (§Roadmap). Listed in prototype order.

| # | Job | Trigger | Freq | In | Out | Purpose |
|---|---|---|---|---|---|---|
| J1 | **Classify worker** | Row enters `pending` | Continuous | New capture | Stages 1–2 | Removes the 60s client block and the sequential bulk-import stall. **Build first — everything else assumes it.** |
| J2 | **Embed + index** | Stage 2 completes | Continuous, batched | Text + image | Embeddings, `search_tsv` | Makes semantic search possible at all. |
| J3 | **Dedupe** | Stage 0 completes | Continuous | `contentHash` | Duplicate link | Exact matches, instantly. Cheapest job here. |
| J4 | **Recluster** | Nightly, or +50 captures | Daily | All embeddings | Cluster assignments | Stacks, similar-capsules, time lanes. |
| J5 | **Resurfacing candidates** | Daily, pre-first-visit | Daily | Age, revisits, recent searches, cluster activity | ≤5 candidates **each with a reason string** | Feeds the shelf. The reason is a hard requirement, not a field. |
| J6 | **Ranking feedback** | Weekly | Weekly | `revisits` + correction ledger | Per-user weight adjustments | Makes retrieval personal. Bounded — see D.3. |
| J7 | **Re-embed on model change** | Manual | Rare | All captures | New embeddings | Migration safety. Needed once and painful without it. |
| J8 | **Thin-project nudge** | Weekly | Weekly | Project counts | ≤1 suggestion | Already computed on `/memory`; becomes a quiet prompt rather than a page users don't visit. |

### D.2 Why these make the product feel alive

The loop that matters is small and closed:

```
capture → classify → suggest → user confirms or corrects → correction row
    ↑                                                            │
    └────── next suggestion is measurably better ◄───────────────┘
                            │
              revisit events ├──► ranking improves
                             └──► resurfacing gets more accurate
```

Both halves already exist as data. Only the consumers are missing. That is a much better position
than needing new instrumentation, and it means the "gets better the more you use it" claim can be
made honestly and *shown* — the acceptance-rate stat on `/memory` is the proof, and it is real.

The constraint that keeps it from becoming noise is already written down (`15:101`): the only
pushes ever considered are upload failure (opt-in) and a weekly digest (opt-in). Resurfacing is
therefore **pull, not push** — a shelf you see when you arrive, empty most days, no badge, no
count, no red dot. `GUIDELINES.html` is unambiguous about this and it is the right call: a badge
turns a memory product into an obligation.

### D.3 Risk and complexity

| Job | Risk | Note |
|---|---|---|
| J1 | Low | Standard queue. The retry/failure semantics are already correct in `classify.ts` — preserve them exactly: failure writes nothing at `confidence: 0`, never a plausible guess. |
| J2 | Medium | Cost scales with library size. Batch, and re-embed only on content change. Decide the provider before starting — it is the stated blocker on P3. |
| J3 | Low | Do it with J1. |
| J4 | Medium | *Stability matters more than accuracy.* A cluster that renames itself weekly is worse than a slightly wrong one that holds still. Pin names once accepted. |
| J5 | **High — the risky one** | Not technically. A bad resurfacing suggestion is a trust event: it teaches the user the feature is noise, and they stop looking at the shelf permanently. Ship it conservative — high-confidence candidates only, fewer than five, and always with a reason the user can argue with. Track dismissals as the kill signal. |
| J6 | High | Unbounded personalisation drifts into a filter bubble where old captures become unreachable. Bound the weight adjustments hard and make them inspectable on `/memory`, per `24_…md`: *"anything the system infers about the user must be viewable and reversible."* |
| J7 | Low | Boring until it is urgent. |
| J8 | Low | Already computed. |

**Privacy.** Sensitive-capture detection (§A.3 idea 5) must run in stage 1, before indexing. A
flagged capture stays out of the search index and out of chat context until the user confirms.
Blur regions applied in annotation must strip the corresponding text from `ocr_text` before it is
written — otherwise the redaction is cosmetic and the secret is still in the index and still
quotable by chat. This is the single most important correctness requirement in the annotation
work.

**Multi-device.** Once the store is Supabase, `user_id` + RLS is already on every table
(`0001_core_schema.sql`). The real work is the durable queue: the Mac app needs an on-disk queue
that survives being offline, which `apps/extension/README.md` already identifies as the durable
path versus the extension's stopgap bridge.

---

## §E — "Come back later" and reference

### E.1 Surfaces

| Surface | Purpose | State |
|---|---|---|
| **Resurfacing shelf** (`/`, above projects) | 3–5 captures worth seeing today, each with a mandatory reason. Empty most days. | Spec'd in `GUIDELINES.html`, data exists on `/memory`, **not built** |
| **Ledger strip** (`/`) | *"N captured · N confirmed in N projects · N waiting · N archived"* | Built. Add one learned-rule line. |
| **Project dashboard** (`/threads/[id]`) | Filmstrip + chat + sources rail | Built and good |
| **Time lane** | One idea across months | Proposed (§A.3 idea 4) |
| **Weekly review** | Optional digest: what you saved, what you never opened, one thing worth revisiting | Proposed. `15:142` already names the Asana pattern — a dismissible card pinned above the list, not a separate page. |
| **Stacks** | Disposable thematic grouping | Proposed (§A.3 idea 3) |

### E.2 Interaction patterns

- **Mark for later.** Not a new star. Pin *is* the mark, it is already in the card-hover spec
  (`15:50`), and a pinned capture floats to the top of its shelf. One concept, not two.
- **Send to future-me.** On the detail page and the overlay: *"Bring this back — in a week /
  in a month / when I next open {project}."* The third is the interesting one, because it is
  contextual rather than temporal and it is the reason Capso is not a reminders app. It writes a
  scheduled resurfacing candidate with a pre-written reason — which satisfies the mandatory-reason
  rule for free, since the user wrote it themselves.
- **Revisit is silent.** Never ask "was this useful?". `Revisit` rows already capture the answer
  from behaviour across four event kinds. A product that asks the user to grade its output has
  offloaded its job.
- **Every resurfaced capture is arguable.** The reason line is mandatory and it must be specific.
  *"You saved this in March and never opened it"* is a reason. *"Recommended for you"* is not.
  `GUIDELINES.html`: *"A recommendation the user cannot interrogate is one they can neither trust
  nor dismiss."*

### E.3 Five improvements

1. **Ship the shelf** (repeats A15 because it is the highest-value item in Part 1).
2. **Promote `whySaved`** — the strongest signal for both retrieval and reason generation.
3. **"Similar capsules" on the detail page** — three thumbnails under the image once clustering
   exists. The lowest-effort way to make the archive feel connected.
4. **Search from anywhere** — ⌘K already exists; it should also be able to answer, not only
   filter. One box, everywhere, both modes.
5. **A reason line on every automated placement**, not just resurfacing. The dashed ring already
   says "Capso put this here"; the *why* is currently only in the confidence percentage.

---

# Part 2 — Capture UX and CleanShot parity

## §A — Capture modes and entry points

### A.1 Comparison

| Mode | CleanShot X | Capso today | Proposed — extension | Proposed — Mac |
|---|---|---|---|---|
| Area select | ✅ core | ❌ | **P1** overlay via `chrome.scripting`, crop from `captureVisibleTab` | **P1** `screencapture -i` |
| Window | ✅ | ❌ | ◐ element-select (DOM-aware — arguably better than a window on the web) | **P1** |
| Fullscreen | ✅ | ◐ viewport only | ✅ exists | **P1**, multi-monitor |
| Scrolling / full page | ✅ | ❌ | **P1** scroll-and-stitch content script | P3 (hard off-browser) |
| Timer | ✅ | ❌ | P3 | **P2** — cheap, and the only way to capture menus and hover states |
| OCR-only | ✅ | ❌ | **P2** — area select → text to clipboard, no capture stored | **P2** |
| Recording / GIF | ✅ | ❌ | ❌ out of scope | ❌ out of scope |
| Self-timer / keystrokes | ✅ | ❌ | ❌ | ❌ |

**Out of scope, deliberately.** Recording, GIF export, keystroke visualisation, hide-desktop-icons
are CleanShot's *presentation* features. Capso's job is memory, and `04_MVP_SCOPE.md`'s litmus
test — *"if it doesn't serve screenshot → AI → memory → retrieval, it's out"* — excludes them
cleanly. Chasing them is the scope-creep failure mode the tripwire table exists to prevent.

**In scope and currently missing, in priority order:**

1. **Area select.** The single biggest gap. Most captures are a region, not a viewport, and a
   full-viewport capture buries the interesting 15% in noise — which degrades OCR *and* the
   classification that depends on it. In the extension this is genuinely cheap: inject an overlay,
   let the user drag, crop client-side from `captureVisibleTab`. No new permission.
2. **Full-page.** The canonical creator capture is a whole landing page. Scroll-and-stitch via a
   content script is the right approach — CDP `captureBeyondViewport` shows the debugger banner,
   which is disqualifying for a tool that must feel invisible.
3. **OCR-only.** Area select minus the storage. Grab the text, skip the capsule. Fits the memory
   product exactly: not everything you read is worth keeping.
4. **Timer** (Mac). Trivial to implement and the only way to capture an open menu or a hover
   state.

### A.2 Entry points

Today there is exactly one: `manifest.json:21-26`, a single `capture-tab` command bound to ⌘⇧U,
plus a popup that offers no modes. Chrome allows four `commands` entries; `chrome.contextMenus`
is not even requested.

**Proposed shortcuts.** Deliberately four, and shared between extension and Mac where the OS
permits:

| Binding | Action |
|---|---|
| ⌘⇧C | Area select — *the default, and the one users learn* |
| ⌘⇧U | Full visible page — the current binding, preserved |
| ⌘⇧F | Full page (scrolling) |
| ⌘⇧T | OCR only — text to clipboard |

⌘⇧C matches the hotkey the docs and onboarding copy already promise (`15:65`, "Show ⌃⇧C"), so the
product stops advertising a shortcut that does not exist.

**Context menu** (extension): "Capture this image", "Capture this element", "Capture selection as
text". Right-click on a specific element is the most precise capture affordance the browser
offers, and Capso does not use it. Requires the `contextMenus` permission.

**Menu bar** (Mac): the tray exists and does nothing. It becomes the mode menu plus recent
capsules — §D.2.

### A.3 The capture panel

Not a launcher. Two surfaces, because a mode picker that requires a click has already lost to the
hotkey.

**The extension popup** — the discovery surface, opened by clicking the toolbar icon:

```
┌──────────────────────────────────┐
│  Capture                         │
│                                  │
│  ▢  Area                    ⌘⇧C  │   ← default; focused on open
│  ▤  Visible page            ⌘⇧U  │
│  ▦  Full page               ⌘⇧F  │
│  T  Text only               ⌘⇧T  │
│  ──────────────────────────────  │
│  Recent                          │
│  [▪][▪][▪][▪]                    │   ← last 4 thumbs → open in Capso
│  ──────────────────────────────  │
│  ● Reading 1 capture             │   ← mark + live status, only when true
└──────────────────────────────────┘
```

Four modes, their shortcuts shown so the popup teaches its own obsolescence, and the four most
recent captures so the popup doubles as the quick-history surface (§D). Bone ground, ink type, no
accent — the product register, since this appears over arbitrary web pages where a brand hue
would fight the page as badly as it fights a screenshot.

**On Mac, the mode selector is the crosshair itself** — as in CleanShot: invoke area select, then
press `space` for window mode, `esc` to cancel, arrow keys to nudge the selection. No panel to
open. The tray menu carries the same four modes for discovery only.

**Opinionated defaults:** area select is the default mode; captures always go to Capso and never
only to the clipboard (with `⌘C` in the overlay as the escape hatch); no save dialog ever; the
post-capture overlay always appears and always auto-dismisses.

---

## §B — Post-capture overlay

### B.1 Critique of what exists

The web app has a genuinely good overlay: `apps/web/components/capture.tsx:356-494`, a 264px card
with four states (`loading` → `suggestion` / `confirmed` / `timeout`), an 8s auto-dismiss that
pauses on hover, and Ask AI / Open / Delete / ✕ in the footer. It respects the brand, it never
blocks, and its states map to the mark's four states as `15:84` specifies.

**The problem is where it lives.** It only exists inside the Capso tab. A user who captures from
Figma, GitHub or a competitor's pricing page gets a Chrome notification and nothing else — no
thumbnail, no project assignment, no note, no undo, in the place they actually are. Then the
capture sits in a module-scope queue on the server (`api/ingest/route.ts:27-29`) until a Capso tab
happens to poll it.

Measured against CleanShot's Quick Access Overlay, the gaps are: it is not present at the moment
of capture, it cannot be dragged out, it cannot be pinned, and there is no annotation entry point.
The first is the one that matters.

### B.2 Spec — the Capso Quick Access Overlay

**Placement.** Bottom-right, 16px inset, above everything. Bottom-right is already the resolved
decision (`05_FEATURE_SPEC_CAPTURE.md`, F1 in `specs/user_flows.md`). On multi-monitor it appears
on the display containing the capture, not the primary. In the browser it is a shadow-DOM overlay
injected into the active tab so page CSS cannot reach it.

**Layout** — 264px, unchanged from the web overlay so all three platforms are one component:

```
┌────────────────────────────────┐
│ ┌──────────┐                   │
│ │  thumb   │  ◐ Reading…       │  ← the mark, in its reading state
│ │  96×72   │                   │
│ └──────────┘                   │
│                                │
│ ● Looks like Pricing redesign  │  ← intent dot + suggestion
│                          82%   │
│                                │
│ [ Accept ]  Discard  Try again │  ← the three verbs, everywhere
│                                │
│ + Add a note                   │  ← expands inline to one line
│ ──────────────────────────────  │
│ ✎ Annotate   ⌘C   Pin   Open  ✕│
└────────────────────────────────┘
```

**States**

| State | Shows | Dismiss |
|---|---|---|
| `reading` | Thumb, mark pulsing at the crimp ring, *"Reading…"* | Never auto |
| `suggested` (0.5–0.8) | *"Looks like {project}?"* + confidence + three verbs | 8s idle |
| `filed` (≥0.8) | *"Filed to {project}"* + Undo. **No confidence** — `15:141` is explicit that showing it here invites second-guessing | 5s |
| `unsorted` (<0.5) | *"Saved to Inbox"* + project picker | 8s |
| `failed` | *"Couldn't read this one"* + Try again. Never a fabricated guess | Sticky until dismissed |

**Keyboard** — usable without the mouse leaving where it was:

| Key | Action |
|---|---|
| `⏎` | Accept |
| `⌫` | Discard |
| `r` | Try again |
| `1`–`9` | File to the nth project |
| `n` | Focus the note field |
| `a` | Annotate |
| `⌘C` | Copy image |
| `p` | Pin |
| `esc` | Dismiss (the capture is already saved — dismiss is never destructive) |

**Rules.** Nothing blocks capture: the overlay renders after the image is already stored, and the
next hotkey press is accepted while it is still visible. Hovering pauses the auto-dismiss. It
never steals focus — critical in the browser, where stealing focus from the page the user is
reading is a hostile act. Dismissing is not a decision; the capture is safe either way.

**Platform differences** — deliberately few:

| | Extension | Mac | Web app |
|---|---|---|---|
| Surface | Shadow-DOM in the active tab | Borderless `NSPanel`, non-activating | In-page element |
| Drag out | ❌ (browsers cannot) | ✅ drag the thumb to any app | ❌ |
| Pin | ✅ becomes a floating in-page card | ✅ floating always-on-top window | ✅ pins in the library |
| Annotate | ✅ in-page editor | ✅ native editor window | ✅ |
| Fallback | Chrome notification if no scriptable tab (`chrome://`, PDF viewer) | — | — |

### B.3 Pinned capsules

CleanShot's pin is its most-loved feature and it maps onto Capso's metaphor unusually well: a
pinned capture is a capsule taken out of the rack and left on the desk.

- **Mac:** always-on-top borderless window, draggable, `⌘W` closes, right-click for annotate /
  copy / open in Capso. Survives app restart.
- **Extension:** a floating in-page card, per-tab, persisted per-origin so returning to that site
  restores the pin. Reference material stays visible while you build against it — the exact
  use-case for a screenshot of a design spec.
- **Both:** a pinned capture is also pinned *in the library*, floating to the top of its shelf.
  One concept across surfaces, not a second bookmarking system (§E.2).

---

## §C — Annotation

There is none today. Nothing in the repository crops, draws, or blurs.

### C.1 Tools

**Must-have — four, and the list should be defended against growth:**

| Tool | Why it earns a slot |
|---|---|
| **Crop** | Fixes the wrong-region capture without a re-take, and directly improves classification by removing noise |
| **Blur / pixelate** | The privacy primitive. `18_…md` R3 names screenshots-contain-secrets as a top risk and nothing addresses it. Blurring before upload is what makes Capso safe to point at a real work screen |
| **Arrow** | The universal "this bit". One tool, one purpose |
| **Box / highlight** | Region-of-interest marking — and it is what feeds §C.3 |

**Nice-to-have:** text labels (they double as strong semantic hints), numbered steps, line, colour
choice (ink only by default — the annotation should not out-shout the screenshot).

**Explicitly not:** backgrounds and device frames, shadows, gradients, stickers. Those are
presentation features for sharing screenshots. Capso annotates to *remember*, not to publish, and
`15:96` already bans decoration.

### C.2 Flow

**Entering.** One key — `a` from the overlay, or the ✎ in its footer. From the detail page, click
the image. There is no separate "editor" mode to discover.

**In.** The image fills the surface; a single row of four tools sits below it. Every tool is a
drag. `⌘Z` undoes. `esc` exits and saves. There is no Save button and no confirm dialog —
annotation is non-destructive by construction, so exiting is always safe.

**Exiting.** The annotated version becomes what is shown everywhere. The original is retained in
the `images` store and reachable from the detail page as *"Original"*. The v3 split
(`lib/store/db.ts:50-71`) already gives the right place to put it.

**Non-destructive is a requirement, not a preference.** Annotations are stored as a vector layer,
never burned into the pixels — except for blur, which must be **destructive on the stored
original**. A recoverable blur is not a redaction, and a user who blurs an API key is entitled to
assume it is gone.

### C.3 Annotation as AI input

This is where annotation stops being a utility and becomes the differentiator. CleanShot's
annotations are for a human reader. Capso's should be for the model too.

| Annotation | Becomes | Effect |
|---|---|---|
| **Box / highlight** | A cropped region sent as a *second* image block alongside the full capture, labelled "the user marked this region" | The model describes what the user cared about, not what happens to be largest |
| **Arrow** | A point of interest with coordinates | Same, weaker signal |
| **Text label** | A semantic hint appended to the prompt as user-authored context | The strongest possible tag — a hand-typed label already outranks everything in `retrieve.ts:92-94` |
| **Crop** | The new capture bounds | Everything downstream improves because the input is cleaner |
| **Blur** | A region excluded from OCR **before** `ocr_text` is written | **Required.** Otherwise the secret is still in the search index and still quotable by chat |

Storage — a new column, one JSON array per capture:

```jsonc
annotations: [
  { "kind": "box",   "bbox": [0.12, 0.34, 0.40, 0.22], "label": "the annual toggle" },
  { "kind": "blur",  "bbox": [0.60, 0.10, 0.30, 0.06] },
  { "kind": "arrow", "from": [0.20, 0.80], "to": [0.35, 0.60] }
]
```

Normalised coordinates so they survive re-encoding at any resolution. `label` text is appended to
`search_text` at weight 4 — it is owner-authored, which is the highest-trust signal in the row.

---

## §D — Cloud, history, resurfacing

### D.1 Requirements

Today: captures live in browser IndexedDB, per-device, no sync, no sharing, no links. History is
the library. The extension queue is a module-scope array that does not survive a serverless
instance change.

| # | Requirement | Note |
|---|---|---|
| D-1 | Capture never waits on the network | Already the rule (`15:23`). Local write first, upload after. |
| D-2 | Durable per-device queue | The extension's in-memory bridge is explicitly a stopgap; the Mac app needs an on-disk queue |
| D-3 | Every capture reachable from every device | The point of the Supabase migration |
| D-4 | Sharing is opt-in and per-capture | A memory tool that shares by default is a liability. **Never** a public-by-default upload. |
| D-5 | Share links expire by default | 30 days, with an explicit "keep forever" |
| D-6 | Sensitive captures never auto-share | Flagged captures require confirmation |
| D-7 | Deletion is total | `deleteScreenshot` already removes the row, the image, and every correction and revisit — the standard to hold cloud deletion to |

### D.2 Recent Capsules — cross-platform

The same component in three places, reading one source:

```
Recent
┌────┐ ┌────┐ ┌────┐ ┌────┐
│ ▪  │ │ ▪  │ │ ▪  │ │ ▪  │
└────┘ └────┘ └────┘ └────┘
 2m     1h     3h    yest.
```

| Surface | Where | Depth |
|---|---|---|
| Extension | Popup, under the modes | 4 |
| Mac | Tray menu | 8 |
| Web | Library, top row when anything is from today | 8 |

Hover reveals copy / link / open. Click opens the capture in Capso. On Mac, drag lifts the file
into any application — the CleanShot behaviour that makes the tool feel native.

Filters, in one row and no more: **Recent · Pinned · Unfiled · {project}**. `15:163` sets the
tripwire at three filters; a fourth requires a real query that failed without it.

### D.3 AI resurfacing in history

- **"Worth another look today"** — the shelf (§E.1), reachable from the tray and the popup as
  well as the library.
- **Contextual resurfacing** — the strongest version and the one only Capso can do: the extension
  knows what page you are on. Landing on the competitor's pricing page you screenshotted in March
  is the moment to surface it, silently, as one line in the popup. No notification. This is the
  capsule the rack pulls for you, and it is the single most compelling demo in the product.
- **"You've saved this before"** — near-duplicate detection at capture time, in the overlay:
  *"Similar to one from March — open it?"* Cheap once `contentHash` and clustering exist.
- **Search-history resurfacing** — a query that returned nothing is a gap. Two weeks later, when
  something matches, one quiet line: *"That thing you looked for in July — this might be it."*

---

## §E — AI in the capture flow

### E.1 Pipeline per capture

```
  ⌘⇧C                    t=0
   │
   ├─ capture ──────────► image in memory              ~50ms
   ├─ downscale ────────► 1600 JPEG + 800 WebP thumb   ~200ms   [stage 0]
   ├─ contentHash ──────► exact-dupe check             ~10ms
   ├─ WRITE LOCAL ──────► capture exists. Safe.        ~50ms
   │
   └─ OVERLAY APPEARS ───────────────────────────────► t ≈ 300ms
        state: reading, mark pulsing
        │
        ├─ enqueue ──► worker
        │                ├─ read      OCR + type + title      [stage 1] ~2s
        │                ├─ interpret summary/intent/project  [stage 2] ~1.5s
        │                ├─ embed     text + image vectors    [stage 3] batched
        │                └─ index     search_text/tsv         [stage 4] ~0
        │
        └─ OVERLAY UPDATES ──────────────────────────► t ≈ 4s
             state: suggested | filed | unsorted | failed
```

**The load-bearing property is that the overlay appears at 300ms, not at 4s.** It appears in its
reading state before any model has been called. Everything after that is an update to a surface
that is already on screen. This is `15:23` — *"Capture path never waits on network, AI, or
animation"* — and it is already how `capture.tsx` behaves. Moving to a worker must not regress it.

### E.2 AI moments

| Moment | Where | Rule |
|---|---|---|
| Reading | Overlay, t=300ms | The mark's reading state. Honest indeterminate progress — `globals.css` already rejects fake percentages, *"a fake percentage that stalls at 90% is worse than an honest sweep"* |
| Suggestion | Overlay, t≈4s | 0.5–0.8 → *"Looks like {project}?"*; ≥0.8 → *"Filed to {project}"* + Undo, no percentage |
| "Understand this" | Overlay footer | Explicit deep pass — the ClickUp Brain pattern at `15:152`: the image opens the conversation |
| Auto-tags | Detail page | Outlined = suggested, filled = yours. Already built and already correct |
| Similar capsules | Detail page | Three thumbs. Needs clustering |
| Duplicate warning | Overlay | *"Similar to one from March"* |
| Contextual resurfacing | Extension popup | The page you are on matches something you saved |
| Learned rules | `/memory` + one line on `/` | The proof that it improves |

### E.3 Marking AI without an accent colour

The brand has already solved this and the solution is better than a colour would be:

> **The mark means Capso decided. Its absence means you did.** Confirming a suggestion takes the
> mark off. — `drafts/brand/GUIDELINES.html`

Applied: the mark sits before anything inferred and disappears the moment the user confirms it.
The dashed ring on cards (`ui.tsx`) already carries this signal for placement — *"Dashed edge =
Capso put this here, you did not"* — so the vocabulary is consistent and partly shipped. Thinking
is the crimp-ring pulse, the one looping motion allowed anywhere.

This is stronger than an accent colour because it is *falsifiable*: the user can check whether the
mark is where it should be. A purple glow on everything AI-adjacent tells them nothing. The
corollary is a hard rule and worth restating for anyone implementing: **the mark may never appear
as a watermark, a sidebar logo, or empty-state decoration.** If it shows up where nothing was
inferred, the signal is worth nothing.

### E.4 Keeping it fast

1. Never block on AI. Already true. Preserve through the worker migration.
2. Overlay before inference — 300ms, not 4s.
3. Stage 2 is text-only. Re-classification does not re-upload the image.
4. Cache stage 1 against `contentHash`.
5. Batch embeddings.
6. Failure produces nothing. `classify.ts` already does this and the reasoning is recorded —
   fabricated metadata at `confidence: 0.86` was indexed by search and quoted by chat as fact.
   No optimisation is worth reintroducing that.
7. Auto-dismiss at 8s. Idle, pausing on hover. Already built.

---

## §F — Extension, Mac app, web

### F.1 Integration strategy

**One mental model, one sentence:** *Capso is in your menu bar and your browser. Press ⌘⇧C
anywhere. It ends up in the same place.*

| | Extension | Mac | Web |
|---|---|---|---|
| Captures | Browser tabs — with URL and page title, which the Mac app cannot get | Everything on screen, multi-monitor | Drop, paste, import |
| Owns | Web context, contextual resurfacing | The global hotkey, the durable queue, pinned windows | Library, search, chat, memory |
| Does not | Leave the browser | Know about URLs | Capture |

The division is not arbitrary. The extension has something the Mac app structurally cannot get —
`pageUrl` and `pageTitle`, which are weighted 3 and 1 in retrieval and which power contextual
resurfacing. The Mac app has what the extension cannot reach: everything outside the browser, and
a queue that survives being offline. Neither replaces the other, and the strategy should stop
treating the extension as a stopgap for the Mac app.

**Ordering.** The extension ships first because it exists, it is closest to done, and area select
plus an in-page overlay make it genuinely good. The Mac app follows the store migration, because
without a durable server endpoint it would inherit the same broken transport.

### F.2 Consistent patterns

1. **The same four shortcuts** everywhere the OS allows.
2. **The same overlay** — one component, three shells. Same layout, same states, same keys.
3. **The same three verbs** — Accept / Discard / Try again. Extension, Mac, web app, Inbox,
   Review. This is `15:140` and it fixes the three-vocabulary problem in §A.2 at the same time.
4. **The same mark rule** — present means inferred, absent means yours.
5. **The same tokens.** Bone/ink, no accent, one shadow level, sub-250ms motion. The overlay
   appears over arbitrary content on every platform, so the brand's no-accent decision is
   load-bearing rather than aesthetic.
6. **Nothing blocks capture** — the rule that survives every platform's failure modes.

### F.3 Top five cross-platform polish features

1. **Unified overlay component** — one implementation, three shells. Everything else follows.
2. **Shared shortcut map**, changeable in one place and reflected everywhere.
3. **Durable offline queue** on both clients, with an honest pending count. The extension's
   current behaviour — captures lost on server restart if no Capso tab is open — is the single
   worst thing in the capture path.
4. **Drag-out from the Mac overlay.** The gesture that makes a capture tool feel native, and the
   one thing the browser can never do.
5. **Contextual resurfacing in the extension.** The page you are on matches something you saved.
   Nothing else in the category does this, and it is the clearest expression of the brand promise:
   the rack holds everything, Capso knows which one to pull.

---

# Prioritised roadmap

Sequenced around the gate `BUILD_LOG.md` identifies: **the web store must move off IndexedDB
before the extension's real transport, auth, production deploy, embeddings, or P2–P6 can land.**
Items are marked **[today]** (ships on the current local store) or **[gated]**.

## Quick wins — 0–2 weeks · all [today] — ✅ **shipped 2026-08-01, see `BUILD_LOG.md` Loop 19**

| # | Item | Why now |
|---|---|---|
| 1 | **Consolidate ⌘K onto `retrieve()`**; delete the inline filter and dead `FilterPill` (`ui.tsx:62`) | One engine. Kills the CJK divergence on the most-used search surface. Half a day |
| 2 | **Fix `retrieve()` scoring** — boundary matching, per-field cap, threshold decoupled from the recency bonus, **revisit term wired in** | Three real defects plus one specified-and-missing signal, all in one 127-line file |
| 3 | **Ship the resurfacing shelf** with mandatory reason lines | Highest-leverage item in the document. Spec exists, data exists, surface does not |
| 4 | **`/review` in the sidebar**, `>= 3` gate removed, `?` shortcut overlay added | A whole screen is currently unreachable below three pending items |
| 5 | **Mobile navigation** below `md` | The product is presently unusable on a phone |
| 6 | **Extension: area select** — injected overlay, client-side crop, second `commands` entry | Biggest capture gap, no new permission, no backend |
| 7 | **Extension: in-page post-capture overlay** | Biggest CleanShot gap. Assign, note, undo — where the user actually is |
| 8 | **Unify to Accept / Discard / Try again** across all four filing surfaces | Executes `15:140`. Removes three vocabularies for one action |
| 9 | **`EmptyState.action` becomes `ReactNode`** | One prop, eight surfaces become actionable |
| 10 | **Focus-visible pass** + one honest model-status string + fix the accent contradiction at `15:36` | Accessibility floor, and stop printing an env-var name at users |

## Next iteration — 1–2 months

| # | Item | Gate |
|---|---|---|
| 11 | **Migrate `lib/store/` to Supabase + auth** — signature-preserving, as its own header promises | **The gate.** Nothing below 12–15 starts first |
| 12 | **Real ingest endpoint** replacing the module-scope queue | [gated] Unblocks production promotion and direct extension writes |
| 13 | **Background classification worker** — jobs table + pg_cron (J1, J3) | [gated] Removes the 60s block and the sequential import stall |
| 14 | **Embeddings + hybrid ranking** at the specified weights; `search_text`/`search_tsv` written with the existing `terms()` | [gated] Makes I5 semantic real. Decide the provider — it is the stated P3 blocker |
| 15 | **`contentHash` dedupe**, retiring the O(n²) heuristic | [gated] |
| 16 | **NL date extraction** + removable pill | [today] Fixes I1 and the product's own seeded example query |
| 17 | **Annotation v1** — crop, arrow, box, blur, with blur stripping OCR text before indexing | [today] The privacy unlock |
| 18 | **Full-page scroll-stitch capture** | [today] |
| 19 | **Landing page** — clay + Fraunces per `GUIDELINES.html`, handing off to bone at the app boundary | [today] There is currently nothing |
| 20 | **Surface `type` as the visual-structure filter** | [today] Zero pipeline work; the field is already populated |

## Strategic — 3–6+ months

| # | Item |
|---|---|
| 21 | **Mac app P2** — hotkey area/window/fullscreen, durable on-disk queue, Quick Access Overlay, pinned windows, multi-monitor, permissions |
| 22 | **Clustering + time-series** (J4) → stacks, similar-capsules, the time-lane view |
| 23 | **Resurfacing loop jobs** (J5, J6) with bounded, inspectable personalisation |
| 24 | **Contextual resurfacing in the extension** — the strongest demo in the product |
| 25 | **Cloud links, sharing, pinned floating capsules** |
| 26 | **Region-of-interest AI** — annotations become structured model context |

---

## Two things that need a human, not an agent

Both are recorded in `BUILD_LOG.md` and neither has moved:

1. **The Chrome extension has never been loaded in a real browser.** Every loop has said so. All
   of items 6 and 7 above build on code that has not once been run in Chrome. This should be the
   first thing done in the quick-win block, before writing any new extension code.
2. **The tray icon has never been visually verified** — the agent shell lacks Screen Recording
   permission, which is the same permission surface the entire Mac capture path depends on. That
   is worth knowing before item 21 is scheduled rather than after.

---

## Decisions this review does not overturn

Stated explicitly so nothing above is read as quietly contradicting a settled call:

- **No mascot, no character, ever.** Settled 2026-08-01 on evidence. Nothing here reintroduces one
  — §E.3 uses the mark, which is the decided alternative.
- **No accent colour.** The recommendations use the mark, the dashed ring, and typographic weight
  for emphasis. `15:36` should be corrected to match `15:112`.
- **Fraunces never inside the product.** Item 19 uses it on the landing page only.
- **No folder trees, no nesting.** Stacks (§A.3 idea 3) are one level and disposable.
- **No gamification, no streaks, no badges.** The resurfacing shelf carries no count and no dot.
- **Capture is never gated.** `16_PRICING_AND_PACKAGING.md` — gate AI reasoning and history depth,
  never capture.
- **Failure writes nothing.** The invariants from Loops 17–18 are preserved throughout: honest
  empties at `confidence: 0`, simulated output persistently flagged, the model never writing
  `userTags`, write-back as a functional merge, citations validated server-side.
