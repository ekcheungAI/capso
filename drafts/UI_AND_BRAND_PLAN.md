# Capso — UI & brand plan

> Applying *Modern SaaS Dashboard UI Design Trends and Principles (2025–2026)* to Capso.
> Written 2026-08-01.
>
> **P0 is done and shipped** — see "P0 status" below. P1–P3 remain proposals.

## The framing problem

**The report is about dashboards. Capso is not a dashboard.**

Its headline pattern — an overview-first layout with a hero row of KPI cards and a North Star
metric in the top-left — assumes the user came to read numbers. Capso's user came to *find a
screenshot they half-remember*. The home screen is a masonry wall of images, not a metrics
surface.

Applied literally, the report would make Capso worse. Applied by translation, most of it is
sharp. The split:

| Report pattern | Verdict for Capso |
|---|---|
| Overview-first layout | **Translate.** Not KPIs — a thin strip of *what needs you today* above the grid |
| North Star in top-left | **Translate.** The North Star is retrieval, not a count. Search and resurfacing own that space |
| Progressive disclosure | **Adopt directly.** Already partly true; make it deliberate |
| Educative empty states | **Adopt — and resolve a spec conflict** (see below) |
| Micro-interactions | **Already done well.** `globals.css:37-143` is the strongest asset in the product |
| Design system / primitives | **Adopt.** Tokens exist; components are ad-hoc |
| Dark mode + personalization | **Gap.** Media-query only, no toggle |
| AI-assisted insights | **Adopt — cheaply.** The aggregations already exist, they are just buried |
| Accessibility | **Gap, and worse than it looks** |
| KPI cards, widget library, drag-resize dashboards | **Reject.** Wrong product |
| Charts, drill-downs, donut/line/bar guidance | **Reject.** Capso has no chart surface and should not grow one |
| Saved views, global date filters, segments | **Reject for now.** Threads already do this job |

Rejecting half a trend report is the point. The report itself warns against "copying Dribbble
shots" and calls cluttered everything-at-once dashboards the top pitfall.

---

## Findings against the actual codebase

### 1. There is no typographic hierarchy. This is the biggest problem in the product.

Counted across `apps/web/app` and `apps/web/components`:

```
 85 × text-xs      (12px)
 48 × text-[11px]
 18 × text-sm      (14px)
 10 × text-[13px]
  3 × text-[10px]
  1 × text-lg      ← a stat number in /memory
  1 × text-xl      ← the first-run H1
```

**Every `<h1>` in the app is `text-sm`** — `inbox/page.tsx:69`, `memory/page.tsx:26`,
`extension/page.tsx:26`. **Every `<h2>` is `text-xs`.** The entire type range of the product is
11px → 14px, a **1.27× spread**. A healthy product runs 3–4×.

The report describes Minimalism 2.0 as explicitly typography-led: *"typography and spacing doing
most of the visual work"*, with a *"strong emphasis on typography to direct attention."* Capso has
removed typography as a tool. Everything is the same size, so nothing leads, so the eye has no
entry point on any screen.

This also matters for the brand conversation: **a flat type field cannot be fixed with a logo.**
Fixing the scale will improve how the product feels more than any mascot will, and it costs a day.

`15_DESIGN_SYSTEM_AND_UX.md:106` already specifies 12/14/16/20/28/36. The build never adopted it.
The fix is to implement the spec that already exists.

### 2. 11–12px body text is an accessibility problem

146 of ~166 text instances are ≤13px. The report treats a11y as *"a legal and business necessity
rather than a trend"* and calls for adjustable font sizes. 11px as the workhorse metadata size —
`ui.tsx`, `capture.tsx` overlay, every chip — is below defensible body-text sizing.

### 3. Contrast is unverified, and one proposed accent already fails

From the palette work in `drafts/brand/board-v3.html`: the candidate Federal Blue `#1f28ae`
scores **1.73:1 on `#141414`** — unusable in dark mode. Terracotta `#e8683a` survives both modes,
which is why `globals.css:12-20` never overrides `--accent`. No contrast audit has ever been run
against the shipping palette. `--muted` `#6b6a64` on `--background` `#fafaf8` should be checked
before anything else changes.

### 4. Eight empty states, all one-liners, none leading anywhere

`page.tsx:83/206/226`, `inbox:59`, `memory:315`, `search:152`, `threads/[id]:32`. Every one is
title + body + optional action. The report calls empty states *"primary levers for SaaS growth
rather than afterthoughts"* and asks for a clear value proposition and a route to first data.

**Spec conflict.** `15_DESIGN_SYSTEM_AND_UX.md:71` bans illustrated empty states: *"No
illustrations of sad boxes/empty folders. A quiet line of text and one action."* These are
reconcilable — *educative* does not require *illustrated*. The true zero state can offer sample
captures (that affordance already exists in `first-run.tsx:64-73`) without a single drawing. But
the doc needs an edit to permit a second line and a real path.

### 5. The AI insights already exist — on the wrong screen

`/memory` computes forgotten captures (`memory:325`), thin projects (`:239`), possible duplicates
(`:206`), and learned rules (`:97`). This is exactly the report's *"automated insights panel that
surfaces notable changes."* It is on a secondary route almost nobody will visit.

`page.tsx:113` already surfaces `{inbox.length} captures need a project` on home. That is the
beginning of the "today" strip — it just has one item in it.

### 6. No theme toggle

`globals.css:12` is `prefers-color-scheme` only; there are zero `dark:` variants and no
`data-theme` hook. The report calls personalization expected behaviour. This also becomes a
*prerequisite* if the accent ever becomes mode-dependent, because there would be no way to test
both modes without changing OS settings.

### 7. Keyboard shortcuts exist but are undiscoverable

`inbox:38-40`, `s/[id]:40-42`, `search:91` implement j/k-style navigation, and there is a ⌘K
palette. The report's "efficiency for experts" box is genuinely ticked — but nothing advertises
it. One `?` overlay would surface work already done.

---

## Plan, in priority order

Ordered by impact per unit of effort, not by how interesting it is.

### P0 status — done 2026-08-01

Typecheck clean, production build green, all 11 routes. Verified in the running app in both modes.

**Two real accessibility bugs were found in the shipping palette and fixed.**

1. `--accent` `#e8683a` measured **3.10:1** as text on `#fafaf8` and **3.24:1** under white — both
   below AA, and it was the fill for every primary button including Confirm in the capture overlay.
   Light mode now uses `#c2461f` (4.80 as text, 5.01 under white).
2. Dark mode then failed the other way: `#e8683a` is fine as text on `#141412` (5.68) but white on
   it is still 3.24. Added an `--accent-ink` token because **the correct ink inverts with mode** —
   white on the light accent, `#141412` on the dark one. 12 buttons across 10 files switched from
   hardcoded `text-white` to `text-accent-ink`. Dark Confirm went 3.24 → **5.68**.

This corrects an earlier claim in `drafts/brand/board-v3.html`: terracotta does *not* survive both
modes. It passes dark and fails light. A mode-dependent accent was always required.

**Type scale**, implementing `15_DESIGN_SYSTEM_AND_UX.md:106`:

- `<h1>` 14px → **20px** semibold across inbox, memory, extension, threads, capture detail
- `<h2>` 12px → **16px** semibold
- first-run `<h1>` → **28px**
- `text-[13px]` → `text-sm`; `text-[10px]` retired to 11px
- Home had **no heading elements at all** — project shelves were `<a>` at 14px. They are now
  `<h2>` at 16px semibold, and a screen-reader-only `<h1>` gives the most-visited screen a document
  outline it previously lacked entirely.

Home now runs 16/14/12/11 rather than 14/12/11.

**Not done, deliberately:** the metadata floor stays at 11px. Raising it to 12px touches ~48
instances and changes density in an image grid — that is a judgment call, not a defect. See open
question 2.

### P0 — Typography and contrast (days, not weeks)

1. Implement the type scale already specified in `15_DESIGN_SYSTEM_AND_UX.md:106` — 12/14/16/20/28/36.
   Page `<h1>` to 20–24px, `<h2>` to 16px, body to 13–14px, metadata floor at 12px. Retire `text-[10px]`.
2. Run a full contrast audit on the shipping palette before any repaint. Fix `--muted` if it fails.
3. Decide the metadata floor deliberately. 11px may be defensible for chips in a dense image grid —
   but it should be a decision with a reason, not an accident.

**This is the highest-value work in this document and it involves no new design.**

### P1 — Activation surfaces

4. Rewrite the true zero state (`page.tsx:78-82`) to carry a value proposition and two routes:
   capture your first, or explore samples. Amend `15_DESIGN_SYSTEM_AND_UX.md:71` to allow it.
5. Promote one insight from `/memory` to the home strip — "3 captures in Inbox are two weeks old",
   "you saved 6 pricing pages this month". Reuse the existing computation; do not build new analysis.
6. Extend `page.tsx:113` into a proper one-line "today" strip: inbox count + one resurfaced capture.
   Not a KPI row. One line.

### P2 — System and personalization

7. Add a theme toggle with `data-theme` on the root, defaulting to system. Prerequisite for any
   mode-dependent accent.
8. Document the primitives that already exist in `ui.tsx` — `EmptyState`, `Thumb`, `Masonry`,
   `IntentChip`, `ConfidenceBar`, `SkeletonGrid`. The report favours a small set of documented
   primitives over a large catalogue. Capso already has the right small set; it is just undocumented.
9. Add a `?` shortcut overlay so the keyboard work becomes discoverable.

### P3 — Brand

10. Pick the colour world (see `board-v3.html`), then redraw the mark and rebuild the icon set.
    `mark/build_icons.py` regenerates everything downstream from one SVG.

**Brand is P3 on purpose.** Nothing in this report suggests identity is what is holding the
product back, and the type-scale finding says otherwise fairly loudly.

---

## Where the brand work and this report agree

Usefully, they converge rather than conflict:

- The report's **Minimalism 2.0** — quiet surfaces, typography doing the work, decoration reduced,
  personality delivered through purposeful micro-interaction — is an argument *for* the
  "brand layer loud, working UI quiet" split already proposed in `board-v3.html`, and *against*
  running riso inks through the working interface.
- The report's **theme personalization and custom brand colours** supports the flexible-palette
  direction: a constant shell with contents that vary.
- The report's **living/adaptive elements** matches the mascot's four capture states, which map
  one-to-one onto the states already in `capture.tsx:268-275`.

The one real tension: the report wants **educative** empty states; the design doc wants **quiet**
ones. Resolve toward quiet-but-actionable — copy and one action, no illustration except on the true
zero state.

---

## Open questions for you

1. **Type scale** — adopt the existing 12/14/16/20/28/36 spec, or deliberately keep the dense
   11–12px field because images should dominate? Both are defensible; the current state is neither,
   it is drift.
2. **Metadata floor** — 11px or 12px? Affects roughly 50 instances.
3. **Does the "today" strip earn its space** above a visual grid, or does it dilute the thing people
   came for?
4. **Brand at P3** — agree, or do you want identity resolved first for external reasons
   (launch, content, build-in-public)? That is a legitimate reason to reorder, and it is your call
   rather than something this report can answer.
