# Capso — brand platform (draft)

> Status: **exploration, not approved.** Produced 2026-08-01 alongside `board.html`.
> Nothing here has shipped; no files under `apps/` were modified.

## The idea

**Everything you capture becomes a capsule.**

A capsule is a small sealed container holding something concentrated, released later on
purpose. That is literally the product pipeline: `⌃⇧C` takes a messy pixel rectangle and
seals it into OCR + summary + type + project routing; weeks later you type a sentence and
it opens.

Three readings run at once, and none of them needs to win:

| Reading | What it lends |
|---|---|
| **Medicine capsule** | Precision, dosage — one, and it works on you later |
| **Coffee pod** | Concentrate and ritual; the daily `⌃⇧C` habit. Crema is already the accent colour |
| **Time capsule** | The retrieval layer — sealed now, opened when it matters |

The ambiguity is the asset: it keeps Capso out of any single category box. No document in
the repo claims this etymology (`README.md:3` calls the name a "working name, unconfirmed"),
so it is unclaimed territory.

**Rename insurance.** The mark is designed as *a capsule*, not as the letters C-A-P-S-O.
`MASTER_PLAN.md:61` records that no trademark or domain check has been run and
`18_RISKS_AND_OPEN_QUESTIONS.md:23` asks for one. The owner has chosen to proceed on the
name; keeping the mark letterform-free means the identity survives if that decision ever
reverses. No wordmark lockups exist yet, deliberately.

## Voice — unchanged

Per `15_DESIGN_SYSTEM_AND_UX.md:28-30`: warm, brief, one line. *"Saved — I'll file it"*,
not *"Item uploaded successfully."* No exclamation marks. Microcopy budget: one line.

**The mascot never speaks in the UI.** The codebase already keeps a persona-name slot open
in its copy architecture; this pass deliberately does not fill it. The mascot is a presence,
not a narrator.

## Where the mascot appears — low-dose

Scarcity is the strategy. It is why the overlay moment lands.

**Appears — five surfaces:**

1. App icon, favicon, extension toolbar + store icon, macOS tray template
2. The post-capture overlay during "Analysing…" — `apps/web/components/capture.tsx:262-387`,
   flagged in-code at `:13` as *"the product's signature moment"*
3. First-run, once — `apps/web/components/shell.tsx:46-52` strips all chrome, making it the
   most brand-exposed screen in the product
4. The **true** zero state only — `apps/web/app/page.tsx:78-82`
5. OG / share image

**Never:** the other seven empty states, sidebar or nav chrome, beside AI responses, toasts,
buttons, or as a per-route loading spinner.

This is backed by evidence, not taste. Across twenty empty states sampled on Mobbin, only
four carried a character at all. Duolingo — the loudest mascot brand in software — does not
put Duo in its empty states. Brilliant shows "Koji" once at onboarding and never again in
the lesson UI.

## Conflicts with existing specs

Recorded so they are not rediscovered later as bugs:

1. **`15_DESIGN_SYSTEM_AND_UX.md:79-84`** — *"NO visual mascot/character in MVP. Post-MVP
   experiment only."* Also `:14` puts mascot design out of scope and `:71` bans illustrated
   empty states. This exploration knowingly overrides the first at the owner's direction.
   The low-dose rule keeps the override narrow, and `:100`'s ban on decorative sparkles on
   every surface still holds in full. **That doc needs an edit before any of this ships.**
2. **`15_DESIGN_SYSTEM_AND_UX.md:109-110`** already flags `#E8683A` as a *placeholder* —
   *"pick against real screenshots."* The palette check on the board tests it against three
   alternates. Terracotta holds up: it doubles as gel-cap and as crema.

## Colour

Locked to the real tokens in `apps/web/app/globals.css:3-20`. No new colours introduced.

```
--accent      #e8683a   terracotta — the only accent, not overridden in dark
--background  #fafaf8 / #141412
--surface     #ffffff / #1c1c19
--foreground  #141412 / #ededea
```

Alternates tested and rejected on the board: espresso `#8c4a2f` (too close to brown,
loses the pod read), matcha `#5f7a4a` (fights the warm neutrals), ink-blue `#3d5a80`
(reads clinical, kills the coffee reading entirely).

## Motion

Any mascot motion reuses the existing vocabulary in `globals.css:37-143` — `--dur-panel`
(220ms), `--ease-out-strong`, `--dur-pop`. **No new animation dependency.** The capsule's
halves pulling apart during "Analysing…" is demonstrated on the board using exactly these
tokens, so what is shown is what can actually ship. The existing
`prefers-reduced-motion` guard at `:108-117` covers it.

## Status of the three directions

| | Direction | Verdict |
|---|---|---|
| **A** | The Capsule — product-as-actor | **Recommended.** Only direction where mascot, logo and app icon are one object |
| **B** | The Archivist — hamster with cheek pouches | Charming but off-concept; needed three attempts to become legible |
| **C** | The Glyph — squircle with a face | Safe, simplest, least memorable; loses the two-tone capsule read |

See `board.html` for renders, reduction tests, dark mode, mono tray tests, in-context
overlay and the palette check.

**The renders are drafts, not assets.** Direction A's outline weight is inconsistent and the
eye placement is slightly high. If A is approved it must be redrawn by hand as clean SVG on
a 24px grid before production.

> **Update — A was approved and redrawn.** The hand-drawn mark and the full icon set
> now live in [`mark/`](mark/README.md). Both defects above are fixed: the outline is a
> single consistent hairline, and the eyes were dropped to `cy8.2` and enlarged to
> `r1.65` (at `r1.25` they rendered as slits below 32px). 16px has its own pixel-hinted
> master. Nothing is installed into `apps/` yet — see `mark/install.sh`.

## Generation provenance

- Model: **Recraft V4.1**, `model_type: vector` — chosen because it emits true SVG, so the
  mark scales to a 16px favicon and recolours for dark mode and a mono tray template without
  regeneration.
- Palette locked at the model level via the `colors` parameter (`#e8683a`, `#fafaf8`, `#141412`).
- 8 marks generated (3 directions + 1 re-roll of B, 2 per batch), **20 of 177.47 credits**
  (157.47 remaining). Note the `get_cost` preflight quotes *per image*, not per batch —
  each `count: 2` batch cost 5, not the 2.5 the probe returned.
- Raw renders in `renders/` — **gitignored** per ekOS rule 6 (generated images stay out of git).
- If a direction is approved, save it as a Higgsfield **Element** (`show_reference_elements`,
  `action=create`) — *not* a Soul. Soul training is for human likenesses; Elements is the
  documented path for non-person subjects, and it is what keeps later poses consistent.
