# Capso route-system redesign — design QA

## Scope and source

- User-reported source: `/Users/ek/Library/Application Support/CleanShot/media/media_H3OhpzKu0T/CleanShot 2026-08-03 at 15.24.01@2x.png`
- Approved brand direction: the canonical Capso lid mark, warm bone/paper palette, capsule rack metaphor, calm organised-memory hierarchy.
- Production preview: `http://localhost:3000/`
- Routes captured in every pass: Home, Tray, Library, Search, Memory, Review, project detail, capture detail, and Chrome extension.
- Interaction states captured in the final pass: Projects drawer, Settings drawer, command palette, empty Search, and populated Search results.

## Three-loop evidence

### Loop 1 — baseline audit

Evidence: `qa/2026-08-03-route-audit/loop-1/`

- [P1] The 122px labelled navigation rail dominated all nine routes and made the content feel secondary.
- [P1] Search rendered two competing inputs: a persistent global field and an unframed page-level field.
- [P1] The page search input inherited a harsh rectangular focus outline inside its rounded container.
- [P2] Secondary route content had no shared page frame, causing edge-to-edge rows and inconsistent spacing.
- [P2] Global import/capture actions floated as unrelated buttons rather than one compact action group.

### Loop 2 — shared-system correction

Evidence: `qa/2026-08-03-route-audit/loop-2/`

- Replaced the desktop rail with a 78px icon-only system using the canonical mark and one Phosphor icon family.
- Reduced active navigation to compact 44px targets and moved text labels to accessible names/tooltips.
- Added a shared 1440px route frame and a compact 56px search header on secondary routes.
- Removed the duplicate global search field from `/search`.
- Rebuilt Search as a centred 920px memory workspace with one composer, grouped prompt starters, and calm result hierarchy.
- Replaced the inner input outline with a single container-level focus treatment.

### Loop 3 — page and interaction verification

Evidence: `qa/2026-08-03-route-audit/loop-3/`

- Re-captured all nine routes after the final production build; every route loaded its expected heading and content.
- Projects and Settings drawers opened and closed successfully; desktop drawers now fit their content instead of forcing full viewport height.
- Command palette opened from the Home Search action and exposed real recent captures.
- Search for `pricing page` returned four ranked matches without console errors.
- Floating Import/Capture controls are grouped and move above the mobile bottom navigation.
- 1280px desktop measurements: rail width 78px, search input height 48px, document scroll width equals viewport width.
- 390px responsive measurements: Home, Search, Library, and capture detail each reported document scroll width 390px for a 390px viewport. The in-app browser's DPR screenshot export returned half-frame mobile images, so those raster files were rejected as visual evidence; the DOM, layout metrics, and desktop captures remained valid.

## Final quality assessment

- Typography: clear page hierarchy, consistent UI font stack, no cramped desktop copy.
- Spacing and layout: consistent route padding, compact chrome, no desktop or measured mobile horizontal overflow.
- Color and surfaces: shared brand tokens only; no stray colors; capsule surfaces remain warm and low-noise.
- Icons and brand: canonical Capso mark only; navigation uses a single Phosphor family at consistent optical sizes.
- States and interactions: navigation, drawers, command search, query results, disabled actions, focus visibility, and reduced motion are present.
- Runtime: zero browser console errors on the final route pass and populated Search state.

## Batch import follow-up

- A multi-image drop now appears as one persistent batch operation instead of a series of unexplained individual arrivals.
- Working state evidence: `qa/batch-import-working.jpg` — total count, current filename, saved/read counters, progress percentage, and a non-blocking safety explanation.
- Completion evidence: `qa/batch-import-complete.jpg` — imported count, failed count, dismiss control, Library action, and Review action.
- A second batch, paste, or file-picker import is prevented while the current batch is active, with a clear status message instead of overlapping progress.
- The temporary visual-QA route was removed before the final production build; the final browser pass reports zero console errors.

## Verification

- `pnpm brand:check`: passed.
- `pnpm capture:check`: passed.
- `pnpm --filter web lint`: passed.
- `pnpm --filter web typecheck`: passed.
- `pnpm test`: 78/78 passed across web and extension (74 web, 4 extension).
- `pnpm --filter web build`: passed.

## Interactive preview spacing follow-up

- Reference comparison: the working demo at `http://localhost:3000/` was measured against the isolated preview at `http://localhost:4173/`.
- Loop 1: replaced the preview's 122px labelled rail and 86×58px nav targets with the working demo's 78px rail, 20/12px inset, 44px icon-only targets, and accessible tooltips. Evidence: `drafts/2026-08-03_capso-interactive-preview/qa/spacing-loop-1.png`.
- Loop 2: captured Home, Tray, Library, and History after the shared-token correction. All pages now use the same rail and `1740px` content edge. Evidence: `drafts/2026-08-03_capso-interactive-preview/qa/spacing-loop-2-*.png`.
- Loop 3: verified the sort-to-capsule animation, evidence retrieval, Tray navigation, Library filtering, History navigation, and all four mobile pages at 390px. Mobile document width stayed at 390px with no horizontal overflow; browser logs reported zero warnings/errors.
- Preview packaging: `npm run build` passed; `npm run test:sites` passed 4/4.

## Production motion optimisation follow-up

- Target: `http://localhost:3000/`, using the existing CSS/Tailwind motion system with no new runtime dependency.
- Motion Gate: kept motion only for filing state explanation, selection feedback, trigger-anchored panels, evidence-drawer orientation, and interactive capsule feedback. Rejected decorative row movement, animated static capsules, and the short-lived pulsing sorter dot.
- Loop 1: the filing operation now commits immediately while a transform/opacity-only capture → seal → rack sequence runs at 440ms per explanatory phase instead of animating `left` for 620ms. Evidence: `qa/2026-08-03-motion-update/loop-1-*-final.png`.
- Loop 2: rapid rail-panel toggles remained stable; the panel enters from the rail in 220ms, keyboard search opens in 160ms and closes with Escape, and the evidence drawer transitions only transform/opacity. Evidence: `qa/2026-08-03-motion-update/loop-2-*.png`.
- Loop 3: Home, Inbox, Library, Search, Memory, and Review rendered successfully; rapid capture selection left exactly one selected card; the selection seal runs once for 160ms; static capsules carry no interaction motion; zero unexpected browser warnings/errors. Evidence: `qa/2026-08-03-motion-update/loop-3-home-final.png`.
- Reduced motion: the compiled global rule collapses animation/transition duration, stops loops after one iteration, and the specialised reading/progress rules preserve visible state. The in-app browser could not switch the OS preference, so device-level reduced-motion feel remains the only unrendered check.
- Verification: motion audit passed with only intentional working indicators and one isolated progress-width transition; brand check, capture check, lint, typecheck, 74 web tests, production build, and `git diff --check` passed.

## Persona-led three-loop follow-up

Evidence: `qa/2026-08-03-persona-design-loops/`

- Loop 1 — Maya (heavy collector): Home was mixing filed captures into “Loose captures”, “Review all” changed destination, the closed evidence drawer was not inert, and capture names repeated their titles. The tray now contains only genuinely waiting captures, all waiting/review paths lead to `/inbox`, hidden drawer content is inert, and capture names are concise.
- Loop 2 — Noor (mobile and motion-sensitive): the five-item mobile bar omitted Memory and Review, while Projects repeated the Library icon. Mobile now uses a distinct More destination with Memory, Review, and project links; Projects uses its own folder icon; the 390px journey has no horizontal overflow.
- Loop 3 — Ken plus final route sweep: ⌘K search returned seven contextual results and ArrowDown/Enter opened the intended capture. Filing the final loose capture exposed two last empty-state defects: a false “Add a project” prompt and missing Inbox/Review page headings. Both are corrected, and every primary route now retains an accessible heading.
- Final Home evidence: `loop-3-final-home.png`; command retrieval: `loop-3-ken-search.png`; mobile navigation and Review: `loop-3-noor-mobile-more.png`, `loop-3-noor-review-empty.png`.
- Browser diagnostics: zero unexpected warnings/errors. The only warning is the existing local-storage fallback caused by disabled Supabase anonymous sign-in.
- Motion accessibility: the reduced-motion CSS removes loops and collapses transitions while preserving static working/progress states. Device-level preference emulation is not exposed by the in-app browser, so this remained a static rule verification.

## Direct-on-image filing follow-up

- Removed the large secondary sorter from both the working product (`:3000`) and isolated prototype (`:4173`).
- Selecting a loose capture now reveals the suggested project and one direct `File here` action over that image.
- Filing removes the capture from the tray and gives a compact Undo receipt; a failed write keeps the capture selected and reports that nothing changed.
- Prototype evidence: `qa/2026-08-03-direct-card-cta-preview.png`.
- Browser interaction check: four cards before filing, three after filing, four after Undo, and zero `.sorter` surfaces.
- Product brand/capture checks, lint, typecheck, 78 tests, production build, prototype build, four Sites tests, and `git diff --check` passed.

## Simple folders-and-tags preview follow-up

- Target: isolated preview at `http://localhost:4173/`; no preview changes were merged into the working product.
- Loop 1 simplified the information architecture to Home, Tray, Folders, and History, reconciled the waiting count, removed dead controls, and made decorative capsule inventory non-interactive.
- Loop 2 made Folders the primary model and Tags the cross-folder model. Tray now supports direct filing, folder changes, editable tags, Skip, and persistent Undo; folder search and tag filters work on desktop and mobile.
- Loop 3 removed ornamental/staggered motion, preserved only short state and orientation feedback, verified reduced motion, and checked all four pages at desktop and 390px with no horizontal overflow.
- Final browser regression covered direct image filing, keyboard filing, Undo, folder search, evidence drawer, History archive/filter, and Quick capture. A fresh browser tab reported no application warnings or errors.
- Evidence and detailed findings: `qa/2026-08-03-simple-product-loops/report.md`.
- Verification: prototype production build passed, Sites tests passed 4/4, brand check passed, and the motion audit reported only the three intentionally accepted state indicators.

## Three additional preview loops

- Loop 4 — trustworthy state: Home and Tray now share one queue; filing and History archive survive page navigation; Undo restores the original queue position across surfaces. Quick Capture was removed because it had no real outcome.
- Loop 5 — folder and mobile clarity: visible folder/screenshot totals react to search and tags, empty results have a Clear action, representative screenshot actions say `Open latest`, and every visible mobile button/navigation target meets the 44×44px baseline.
- Loop 6 — import and navigation integrity: selected images now enter Tray after batch completion, the first imported item receives focus, Review is the primary follow-up, Import keeps an accessible name on mobile, and primary navigation supports URLs plus browser Back/Forward.
- Priority recommendation: build folder detail, universal OCR/semantic screenshot search, production-grade batch ingestion, and bulk Tray review before behaviour-learning controls or new capture channels.
- Evidence and product sequence: `qa/2026-08-04-three-more-loops/report.md`.

final result: passed

## 2026-08-12 — generated visual language (D17), read this before auditing icons or empty states

Two findings here will look like regressions to a future audit and are not. Recorded so they are not re-litigated.

- **Empty states now carry art.** Loop-2 and Loop-3 findings assumed `15_DESIGN_SYSTEM_AND_UX.md`'s "no illustrations of sad boxes/empty folders". That ban was reversed by owner decision D17. What survives is the *subject* rule — an empty slot reads as **ready**, never as failed — and the one-action, one-line rule, both unchanged. Art has an asserted chroma ceiling so it cannot out-saturate a capture; principle 5 was not repealed.
- **The one-icon-family rule is preserved, and the count went down.** Loop 2 logged "two competing icon families" as a P1 and fixed it. This loop does not reopen it: every generic UI verb (`House`, `Tray`, `SquaresFour`, `MagnifyingGlass`, `Plus`, `X`, …) stays Phosphor. Exactly three custom glyphs are added — `capso-rack`, `capso-deck`, `capso-seat` — and only because they are Capso's own nouns, which Phosphor cannot express. Separately, the Mac app was found to be running an **undocumented third family**: six hand-drawn inline SVGs across `AnnotationEditor.tsx`, `CaptureOverlay.tsx` and `PinCapture.tsx`, with no `@phosphor-icons/react` in `apps/mac/package.json`. Loop 2's fix had only ever covered web. Those six are absorbed into the generated family, so the family count goes **3 → 2, not 2 → 3**.
- **`AnnotationEditor.tsx` carried a second fake screenshot** (`PREVIEW_IMAGE`, a 1280×760 inline SVG dashboard) that escaped `pnpm brand:check` only because it used CSS *named* colours — `royalblue`, `tomato`, `midnightblue` — which the scanner's `#[0-9a-fA-F]{3,8}` regex does not match. Replaced with a generated sample. Worth knowing the scanner has this blind spot.
