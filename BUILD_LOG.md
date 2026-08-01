# Capso Build Log

Append-only. One entry per build loop, per `20_AGENT_LOOP_INSTRUCTIONS.md` §6.

---

## Loop 01 — Monorepo scaffold
**Date:** 2026-07-31 · **Phase:** P0 Foundation · **Outcome:** done

```
Objective: pnpm monorepo with apps/web, apps/mac, packages/shared installing and typechecking clean.
Phase/tasks: P0 task 1 (monorepo scaffold)
In-scope files: package.json, pnpm-workspace.yaml, .gitignore, .env.example, apps/**, packages/shared/**
Out of scope: Supabase project, auth, tray UI, CI, Sentry/PostHog, any capture code
Done-when: pnpm install clean; pnpm typecheck green in all 3 packages; web + mac both build
Verification: pnpm install && pnpm typecheck && pnpm lint && pnpm --filter web build && pnpm --filter mac build && cargo build
```

**Verification evidence**
- `pnpm typecheck` — Done in all 3 workspace projects (apps/mac, apps/web, packages/shared)
- `pnpm lint` — apps/web eslint clean
- `pnpm --filter web build` — compiled successfully, 2 static routes
- `pnpm --filter mac build` — vite built in 430ms
- `cargo build` (src-tauri) — `Finished dev profile in 1m 01s`, binary at `target/debug/mac` (24 MB)
- Secrets check: only `.env.example` (template, no values) is tracked

**Deviations from plan**
1. **Next.js 16.2.12, not 15.** `create-next-app@latest` now ships Next 16. Pack docs say "Next.js 15 App Router" throughout. App Router APIs used here are unchanged; Next 16 has breaking changes vs. older training data (see `apps/web/AGENTS.md`). **Owner decision needed:** accept 16 and update the pack's version strings, or pin to 15.
2. Tauri scaffolded at repo root by `create-tauri-app` and moved into `apps/mac`; nested `.git` dirs from both scaffolders removed (single repo at Capso root).

**Blockers surfaced (STOP rules)**
- Supabase project creation → external service + likely new recurring charge (org already has 4 active projects). STOP rules 3 & 4. Awaiting owner.
- GitHub remote + Vercel deploy → external. STOP rules 3 & 6. Awaiting owner.

**Next loop:** Loop 02 — Tauri menu-bar tray shell (P0 task 4), fully local, no external dependency.

---

## Loop 02 — Menu-bar tray shell
**Date:** 2026-07-31 · **Phase:** P0 Foundation · **Outcome:** done

```
Objective: Tauri app runs as a macOS menu-bar (Accessory) app with a tray icon that toggles a popover window.
Phase/tasks: P0 task 4 (Tauri menu-bar app boots with tray icon + empty popover window)
In-scope files: apps/mac/src-tauri/{Cargo.toml,src/lib.rs,tauri.conf.json}, apps/mac/src/App.tsx
Out of scope: hotkeys, capture, upload queue, auth, AI — all later phases
Done-when: cargo build green; no dock icon; tray click toggles window; Quit item exits
Verification: cargo build; manual launch of target/debug/mac
```

**Verification evidence**
- `pnpm --filter mac typecheck` — clean
- `cargo build` — `Finished dev profile in 23.44s` (tray-icon + image-png features added)
- Launched `target/debug/mac`: process runs; `osascript … get background only of process "mac"` → **true**, confirming `ActivationPolicy::Accessory` (no Dock tile, no app-switcher entry)

**Deviations / gaps**
- **Tray icon not visually verified.** `screencapture` from the agent shell returns "could not create image from display" — the shell lacks Screen Recording permission. Owner re-granted permissions mid-loop but the shell is still blocked, so the grant likely applied to the Claude app rather than the terminal. Code path is standard `TrayIconBuilder`; pixel QA deferred to owner launch or to the bundled `.app` in P7. **This is the same permission surface P2 depends on — resolve before P2 starts** (`specs/permission_model.md`).
- Scaffold demo assets (`react.svg`, `tauri.svg`, `vite.svg`, greet command) removed; popover renders a placeholder panel.

**Next loop:** blocked on owner — see MASTER_PLAN "Known blockers". Local-only work remaining in P0 is CI config and telemetry init, both unverifiable without a remote/keys.

---

## Loop 03 — Interactive demo: state, capture, detail, organise
**Date:** 2026-07-31 · **Phase:** demo track (ahead of P2/P4, owner-directed) · **Outcome:** done

Owner's verdict on the static demo: "I don't see and feel much demo experience — how do I screenshot? how do I organise? how do I move files? what does each screenshot tell me? where do I optimise my memory?" All fair; the four pages were mock renders with no state.

**Built**
- `lib/store/` — IndexedDB behind an async seam whose function names match the future Supabase calls, so P1 swaps the implementation only. Seeded on first run; "Reset demo data" restores.
- `/s/[id]` detail view — every element `13_WEB_APP_PLAN.md` lists, plus a revisit event on open (F5).
- Organise — project dropdown on detail, keyboard-first inbox triage (j/k/⏎/number), drag card → sidebar project, bulk move, inline project creation.
- Capture — drop/paste anywhere plus a Capture button; overlay with the four chip states from `05_FEATURE_SPEC_CAPTURE.md`.
- Every assignment writes a `corrections` row (accepts included, per 07:34).

**Verification**
- `pnpm --filter web typecheck` / `lint` — clean
- Browser pane: changed a capture's project on `/s/s1`; sidebar counts moved live (Pricing 3→2, Q3 2→3). IndexedDB read-back confirmed `threadId: "q3-launch"`, `assignmentSource: "manual"`, and one `corrections` row with `wasAiAccepted: false`.
- Capture button → overlay "Saved to Capso UI bugs · edit" with Ask AI / Open / Delete; library 10→11.

**Deviations / notes**
- Classification is simulated (`lib/classify.ts`) with the real 8-field shape. Loop C swaps the body for MiniMax M3.
- Overlay placed bottom-right, resolving the 05 (bottom-left) vs F1 (bottom-right) conflict in favour of F1. `05_FEATURE_SPEC_CAPTURE.md` still needs the edit.
- `why_saved` made editable — owner decision; `06_FEATURE_SPEC_AI_MEMORY.md` §5 ("not separately editable in MVP") is now stale and needs updating.
- Turbopack served a stale module graph after `lib/mock.ts` was deleted; fixed by clearing `.next`. Worth remembering when a route 404s with a resolved-on-disk import.

**Next loop:** Loop C — real MiniMax M3 classification, starting with the image-support curl.

---

## Loop 04 — Mobbin optimisation pass + memory surface + real M3 client
**Date:** 2026-07-31 · **Phase:** demo track · **Outcome:** done

**Mobbin-grounded fixes.** Pulled references for the two ungrounded surfaces. Bonsai/Gusto showed search as a ⌘K overlay with recents, not a page — mine was a dead link, the slowest path to the one job the product exists for. Runway/Air showed prev/next and a file meta line on asset detail — mine was a dead end you had to back out of. Both built. Library filters made real (intent, project, date range, count, Reset) — they were decorative pills, the most obviously hollow thing left.

**Memory surface** (`/memory`, three tabs) — see the new `24_FEATURE_SPEC_MEMORY.md`. Reads the correction ledger and shows it back in plain language, with per-correction Forget. Verified live: the project move made during loop 03 testing surfaces as "When you correct it, you usually move things to Q3 launch campaign (1 time · mostly Competitor)".

**MiniMax M3 client.** `lib/ai/minimax.ts` (server-only, Anthropic-compatible endpoint, base64 image blocks) + `POST /api/classify` returning the 8-field contract validated against a shared zod schema with one repair retry, few-shot correction lines injected, and a prompt rule that OCR text is content and never instructions. `GET /api/classify` is a status probe; the sidebar states whether output is MiniMax M3 or sample data.

**Verification**
- `pnpm --filter web typecheck` / `lint` — clean (fixed two React Compiler errors properly: `Date.now()` out of render, palette cursor reset out of an effect)
- `curl POST /api/classify` without a key → `503 {"configured":false}`; capture still completes via fallback; sidebar reads "AI: sample data"
- Browser pane: ⌘K palette, detail prev/next ("7 of 14"), memory tabs, capture → overlay → filed

**Doc debt paid:** `24_FEATURE_SPEC_MEMORY.md` written; MASTER_PLAN decisions D11–D14 recorded (extension, M3, memory surface, editable `why_saved`).

**Still owed:** `05_FEATURE_SPEC_CAPTURE.md` overlay position (bottom-right), `06_FEATURE_SPEC_AI_MEMORY.md` §5 (`why_saved` now editable), `10_DATA_MODEL.md` (`screenshots.archived`), and the `captures`/`screenshots` table-name conflict across docs.

**Next loop:** thread chat with real retrieval (`/api/chat` + `search_memory`), then the Chrome extension.

---

## Loop 05 — Thread chat with retrieval and citations
**Date:** 2026-07-31 · **Phase:** demo track · **Outcome:** done

`messages` store added (IndexedDB v2), `POST /api/chat` calling M3 with a system prompt that forbids inventing captures and requires `[id]` citations. Citations are filtered server-side against the ids actually supplied, so the model cannot cite something it was never given. The thread page now has a real composer, persisted turns, citation chips resolving to the capture, and a sources rail that switches from "in this project" to "sources" once an answer cites.

**Deviation (deliberate):** retrieval runs client-side — the demo store is local IndexedDB, so the scope (this project's captures + keyword matches elsewhere) is assembled in the browser and passed as context. `specs/api_contracts.md` specifies a model-invoked `search_memory` tool; that arrives when data moves to Supabase in P1.

**Verification:** typecheck/lint clean; asked "What do these pricing pages have in common?" in Pricing page redesign — turn persisted, and without a key the UI states exactly what to set rather than failing silently.

---

## Loop 06 — MiniMax M3 live
**Date:** 2026-07-31 · **Phase:** demo track · **Outcome:** done

Key applied to `apps/web/.env.local` (gitignored, chmod 600; `git check-ignore` confirmed).

**Open assumption resolved: the coding-plan key DOES accept base64 image blocks** on `/anthropic/v1/messages`. No fallback to the OpenAI-compatible path needed.

**Classification** — canvas PNG (English + 繁體中文), 200 in 3.9s:
- OCR verbatim and correct, including `最受歡迎`, `年繳可省 20%`, `開始免費試用`
- `project_suggestion: "Pricing page redesign"`, `confidence: 0.92` → auto-assign band
- Latency inside the <5s p50 target from `21_ACCEPTANCE_CRITERIA.md`

**Chat** — asked "Which of these mentions an annual discount, and what percent?" in Pricing page redesign. Answer quoted "Billed annually · Save 20%" from OCR, cited 5 captures, and correctly stated which captures do *not* mention it rather than inventing. Cross-project retrieval pulled in matches from outside the project.

**Fixed:** the Capture button generated SVG, which the route rejects, so it silently fell back to simulated output — exactly the failure that would hide a broken model. Now renders a canvas PNG.

**Note:** the key has appeared twice in the session transcript. Rotate after testing.

---

## Loop 07 — Motion pass + Photos-app patterns + persona walkthrough
**Date:** 2026-07-31 · **Phase:** demo track · **Outcome:** done

**Motion audit (skill `optimize-ui-motion`).** `scripts/audit-motion.sh` returned zero candidates in every category — because there was essentially no motion, including **no reduced-motion coverage**. Findings and fixes:

| Finding | Fix |
|---|---|
| Card used Tailwind's bare `transition` (animates every property) | Scoped to `transition-[box-shadow,transform]`, 120ms, + 2px hover lift |
| Overlay appeared instantly with no spatial origin | Anchored entrance from the Capture button: 12/16px travel + `scale(.96)`, 220ms `--ease-out-strong` |
| Chip state change (loading→suggestion) swapped with no transition | Keyed crossfade, 160ms |
| ⌘K palette had no entrance | Opacity + `scale(.98)` only, 160ms — **no travel**, because standards put keyboard-driven surfaces at "instant action" |
| `ready === false` rendered the text "Loading…" | `SkeletonGrid` preserving masonry shape with a 1.6s shimmer |
| Filing was silent | Toast with **Undo** on inbox triage and drag-to-file |
| No `prefers-reduced-motion` | Global guard added |

Rejected: page-transition animation between routes (frequent, keyboard-driven, would add latency to every navigation) and any card entrance stagger (the grid is re-rendered on every filter change; staggering would make filtering feel slower).

**Photos-app patterns** ([Apple Photos](https://mobbin.com/screens/9368ed10-5916-4de5-846c-175a5301923c), [Google Photos](https://mobbin.com/screens/28fa6013-5b82-4b74-8199-bfdb14d1a0e8), [Faire](https://mobbin.com/screens/3701c325-f3d6-49fd-a3ac-9bd0bbd5c70d)): detail view gains a **filmstrip of neighbouring captures**, current one outlined, neighbours dimmed — position in the set is visible and moving is one click instead of a blind arrow press.

**Persona walkthroughs**
- *Solo founder, keyboard triage*: ⏎ filed the top capture, toast offered Undo, inbox and sidebar counts updated live. No friction.
- *Designer scanning references*: filmstrip + prev/next + editable `why_saved` all reachable without returning to the grid.
- *Growth operator*: covered by the ⌘K palette and `/memory` verified in loops 04–05.

**Also fixed:** the Inbox "Try again" button still alerted "wired up in Loop C" after Loop C shipped. It now re-runs classification for real and reports whether the re-read used MiniMax M3 or sample data.

---

## Loop 08 — Spec conflicts closed; build ready for design review
**Date:** 2026-07-31 · **Phase:** demo track · **Outcome:** done

All four cross-doc conflicts found during exploration are now resolved in the owning docs: overlay position (05 → bottom-right, F1 wins), `why_saved` editability (06 → editable, D14), `screenshots.archived` (10), and the `captures`/`screenshots` table-name split normalised to `screenshots` across 04/05/06/07/08/19 with storage buckets aligned to `originals`/`thumbs` per 14.

**Verification:** `pnpm --filter web build` green — 9 routes (5 static, 4 dynamic: both API routes, `/s/[id]`, `/threads/[id]`). Typecheck and lint clean.

**Paused here for owner design review before starting the Chrome extension.**

---

## Loop 09 — Search becomes an agent; drag becomes physical
**Date:** 2026-07-31 · **Phase:** demo track · **Outcome:** done

Owner: *"I want to know 'what are some good designs I have put together for mobile UI'"* and *"I should feel like I can rearrange screenshots into folders."* Search filtered instead of answering, and drag had no physical feedback.

**Search is now an agent over the library.** `lib/retrieve.ts` scores term overlap across title, the user's own `why_saved` note, summary, the human intent label (so "mobile UI design" reaches `design_inspiration`), project name and OCR text, with a mild recency nudge. Typing filters instantly; Enter/Ask sends the top 12 to the model and answers in prose with citation chips that carry thumbnails. Results below are marked ★ cited and say what they matched on.

Verified with the owner's exact question — answer: *"there's one mobile UI design reference saved: [Mobile nav drawer] … That's the only mobile-related design in the available captures"*, and it volunteered that other folders might hold more rather than padding the list. Grounded, and honest about scope.

**Drag now has weight.** Dragged card drops to 0.35 opacity and scales down; the sidebar advertises every project with a dashed ring while a drag is live and shows a "drop N" badge; the hovered target scales and fills with accent. Dragging a selected card carries the whole selection. Drops and filter changes run inside `document.startViewTransition` (feature-guarded) so surviving cards travel to new positions instead of teleporting. Multi-move gets one Undo toast that restores every capture's previous project.

**Bug caught by screenshotting:** the translucent sticky header let the accent Ask button bleed through while scrolling, which read as a rendering fault. Header is now opaque.

**Verification:** typecheck, lint, production build all green.

---

## Loop 10 — Chrome extension
**Date:** 2026-07-31 · **Phase:** demo track (D11) · **Outcome:** done

`apps/extension/` — MV3: `captureVisibleTab` on hotkey (⌘⇧U) or toolbar popup, POST to `/api/ingest`, desktop notification on success or failure. Chrome-restricted pages (`chrome://`, Web Store) are reported rather than failing silently.

**Bridge:** a service worker cannot write to the app's IndexedDB, so `/api/ingest` holds an in-memory queue (max 20, drain-once) and the open Capso tab polls it. Becomes the real Supabase ingest endpoint in P1.

**Bug caught during verification:** the drain was gated on `document.visibilityState === "visible"`. That is wrong beyond the test harness — capturing from another Chrome tab leaves the Capso tab hidden, so nothing would land until the user switched back. Now polls unconditionally and drains immediately on focus/visibility change.

**Verification**
- `POST /api/ingest` → `{queued:1}`; `GET` drains once and returns `[]` after; malformed body → 400
- Posted a real canvas PNG (English + 繁體中文 nav labels) → drained → classified by M3 → appeared top of grid as **"Mobile app navigation drawer mockup"**
- typecheck + lint clean

**Not verified by me:** loading the unpacked extension in Chrome itself — `chrome://extensions` is out of reach from the in-app browser. Owner must confirm the manifest loads and the hotkey registers.

**Docs:** M10 added to `04_MVP_SCOPE.md`; capture path and its four limits documented in `05_FEATURE_SPEC_CAPTURE.md`; install steps in `apps/extension/README.md`.

---

## Loop 11 — Extension distribution
**Date:** 2026-07-31 · **Phase:** demo track · **Outcome:** done

`pnpm build:extension` zips `apps/extension` into `apps/web/public/` and writes `extension-version.json`; `/extension` serves the download with version, build time and install steps. Sidebar links to it.

**Update mechanism, honestly.** Chrome auto-updates only Web Store extensions and refuses self-hosted `.crx` outside enterprise policy, so there is no silent update. The background worker fetches the published version on startup and notifies once per version when behind; the popup shows the same nudge; updating is replace-folder + Reload, which preserves the extension ID and hotkey because the path is unchanged. Web Store publishing (real auto-update) needs a US$5 registration and review — **owner decision, STOP rule 4, not taken**.

**Verification:** `/capso-extension.zip` serves 200 (7.4 KB, 6 files, README excluded); `extension-version.json` reports v0.1.0; `/extension` renders. Zip and version file are gitignored as build artefacts.

---

## Design reference pass — Mobbin
**Date:** 2026-07-31 · **Phase:** P0 (out-of-band, owner-requested) · **Outcome:** done

Owner asked mid-loop to reference Mobbin for UX/UI preparation. Added a **Reference board** section to `15_DESIGN_SYSTEM_AND_UX.md` covering four surfaces (library/inbox grid, inbox triage, thread chat, search results) with 14 cited references and the specific mechanic to copy from each. No code changed. Key adoptions: Notion Mail's three-verb AI action menu (Accept/Discard/Try again), ChatGPT's inline-citation + sources-rail split for AC-CHAT-02, applied-filter pills for the date-extraction feature, and mymind/Fabric/Savee for grid density.

---

## Loop 12 — The portal proves it's organised
**Date:** 2026-08-01 · **Phase:** demo track (M11) · **Outcome:** done

Owner: *"however unorganised you are with screenshotting, at the end this portal will still be organised… it can start with a template as in what kind of 'character' you are."* The mechanism worked; the payoff was invisible. The library was a flat wall grouped by a month you didn't choose, projects existed only as sidebar rows, and first run silently seeded four hardcoded product projects at everyone regardless of what they do.

**Two locked spec decisions reversed, with the reasoning recorded rather than the docs quietly contradicted.** `03` listed persona templates as out of scope ("the classifier adapts via the learning loop, not via modes") and `15` said "no folders". Both amended: **modes stay out, starter kits are in** — a role creates projects and nothing else, stores no state, and is never consulted again; and shelves are a read-only *view* of threads the system already maintains, so the user still never builds a hierarchy. The real argument for the reversal is mechanical, not cosmetic: the classifier can only file into projects that exist, so with an empty project list every early capture routes to Inbox regardless of confidence and a new user's first session is a triage queue instead of the product working.

**Starter kits.** `lib/templates.ts` ships four roles (Marketing / Product & design / Founder / Start empty). Each project carries a description written as a hint the model can act on, not marketing copy. `loadAll()` no longer auto-seeds; a `capso.setup` key records how the library came to exist, so "Start empty" and "I deleted everything" are never mistaken for "never set up". Libraries that predate the picker backfill the key on first read and are never interrupted. The demo fixtures survive as an opt-in "Explore with sample captures".

**Descriptions reach the classifier.** `Thread.description` was specced in `10` and `07` but had never been implemented — `/api/classify` was sending bare project names, so the model was guessing from labels. Candidates now render as `- "Name": description` and the system prompt tells the model to decide on the description. Verified with the real M3 pass: a canvas-rendered SaaS hero was filed to **Landing pages** at 72% under the Marketing kit — the name alone would not have distinguished it from "Competitor ads & positioning".

**Shelves.** `/` defaults to per-project sections with count, description, last-active date, and a **"N waiting"** chip when the Inbox holds captures suggested for that project. `Months` and `Intent` are alternate groupings behind a segmented toggle; all three compose with the existing intent/project/date filters. Every shelf is a drop target, so filing by drag works on the thing you can see rather than only the sidebar row. Drag/drop behaviour and the move-with-undo pipeline were duplicated across sidebar and library, so they were extracted once into `DropZone`/`useDragCount` (`components/ui.tsx`) and `useMoveCaptures` (`lib/move.ts`).

**Ledger.** One line above the shelves: `N captured · M filed across K projects · J waiting · A archived`. Deliberately **no "0 lost" counter** — delete is a hard delete (`10 §retention`), so that number cannot be measured and claiming it would be decoration, not reassurance.

**Two bugs caught while verifying, both by reading the page rather than assuming:**
- A fresh starter kit listed its projects in reverse. Five `createThread` calls stamp timestamps milliseconds apart, and shelves sort by recency. `applyTemplate` now shares one `lastActiveAt` across the set and spaces `createdAt` by a millisecond in declared order, with `createdAt` ascending as the sort tiebreak — so an untouched kit reads in the order the picker promised, and recency takes over once you actually use it.
- Putting the description in `title` on the sidebar `<Link>` replaced the row's accessible name: the accessibility tree announced "Ads, landing pages and taglines from other companies…" instead of "Competitor ads & positioning". Moved onto the inner label span; the tooltip survives, the name is the project again.
- Also fixed: `assignThread` bumped `last_active_at` in IndexedDB but the provider never refreshed the thread in memory, so a drop did not move its shelf until reload — a move that visibly did nothing.

**Verification**
- typecheck, lint, production build all green (11 routes)
- Fresh state → picker appears → Marketing → five shelves in declared order, ledger `0 captured`
- Pasted a real canvas PNG → real MiniMax-M3 pass → "SaaS landing page hero section", intent competitor, 72%, suggested **Landing pages** → confirmed → ledger `1 captured · 1 filed across 1 project`
- Dragged that card to another shelf → both counts updated, target shelf rose to top, `Moved 1 capture to Campaign ideas · Undo`
- `Months` → "August 2026 · 1"; `Intent` → "Competitor · 1"; back to `Projects` intact
- Reset demo data → picker returns → Explore with sample captures → all 13 fixtures across the 4 demo projects, ledger `13 captured · 10 filed across 4 projects · 3 waiting`, waiting chips on the right two projects
- Console clean (only dev-mode Fast Refresh notices)

**Docs:** M11 added to `04_MVP_SCOPE.md`; starter-kit decision + reasoning in `03_PERSONAS_AND_USE_CASES.md`; principle 2, the folder-tree ban and the onboarding section amended in `15_DESIGN_SYSTEM_AND_UX.md`; description implementation noted in `07_FEATURE_SPEC_PROJECT_THREADS.md`.

---

## Loop 12 — Memory layer foundations: tags, capture context, CJK search
**Date:** 2026-08-01 · **Phase:** P1 groundwork · **Outcome:** done (Supabase apply pending owner decision)

Owner asked for two things: memory that actually retrieves (proper tagging + OCR + search) and a display worth looking at. Exploration found the gap was foundations, not polish. This loop lands the data layer for the first half.

**CJK search was broken in production code, not in theory.** `terms()` in `lib/retrieve.ts` filtered every token to `length > 2`. Two-character words are the most common length in Chinese, so `競品`, `定價` and `日誌` all tokenised to `[]` and returned nothing; longer phrases like `更新日誌` survived only as one unbreakable token that could never match `日誌` alone. Numbers under three digits (`68%`, `$29`) were dropped for the same reason — precisely the exact-match recall 08 §3 says keyword search exists for. Now segmented with `Intl.Segmenter` (no dependency): the length rule is Latin-only, single-character CJK segments are dropped when longer ones exist but kept when they are all there is, and numerics survive at any length. Verified: `競品` → 1 result, was 0.

**Two-tier tagging.** `Screenshot` gained `tags` (model-proposed) and `user_tags` (owner-typed), kept strictly separate on the Air model — removing a suggestion writes a `user_corrections` row with `field: "tags"` and shows up in /memory as *rejected the tag "…"*; adding your own is not a correction, because volunteering information is not disagreement. The classify contract gained `tags` with a `.default([])` so a missing list never burns the single repair retry.

**The extension's page context was being thrown away.** `background.js` has always sent `pageUrl` and `pageTitle`; `/api/ingest` typed them, and `capture.tsx` read neither. They now persist on the row, feed search (page title weighted 3, URL 1) and reach the classifier — fenced and labelled as untrusted data, since a page title is attacker-controlled text.

**Bug found while verifying:** deleting the IndexedDB out from under an open tab left the app shimmering forever. Cause: `db.ts` `open()` handled `onsuccess`/`onerror` but not `onblocked`, so a blocked version upgrade never settled the promise, `ready` never flipped, and the skeleton grid was indistinguishable from a slow load. This was reachable for real — two Capso tabs open across a `DB_VERSION` bump, which this app has already done once (1→2). Fixed with an `onblocked` rejection, `onversionchange` closing stale connections, not caching failed opens, and a `loadError` state that Shell renders as plain text with a Reload button.

**Also:** `routeConfidence` no longer redeclares the 0.8/0.5 thresholds that `packages/shared` already exports. The tag input handles Enter explicitly rather than relying on a single-input form's implicit submission.

**Supabase is live.** Owner created the project (`xbxedriuelwqjypdkvex`, ap-southeast-2, US$10/mo — past the org's 2-project free allowance); `supabase/migrations/0001_core_schema.sql` applied. Five tables, RLS enabled and an owner policy on every one, GIN on `tags`/`user_tags`, HNSW on `embedding`. Two documented departures from `10_DATA_MODEL.md`: the new tagging/context columns, and `search_tsv` built with the `simple` config over a pre-segmented `search_text` column rather than `english` over raw text, because hosted Supabase has no `zhparser` and `english` treats a run of Han characters as a single token. Proven in Postgres: `websearch_to_tsquery('simple','定價')` matches a document containing `定價 頁面`, and `pricing` still matches too.

Follow-up migration moved the `vector` extension out of `public` (Supabase linter `0014`) while `screenshots` was still empty, so it cost nothing; `embedding` is still `vector(1536)` and the HNSW index survived. The two remaining security lints both concern `public.rls_auto_enable()`, a **platform-managed event-trigger function** owned by `postgres` with `search_path` pinned — event-trigger functions cannot actually be invoked over RPC, so the warnings are noise and the object is not ours to change.

Keys are in `apps/web/.env.local` (gitignored, chmod 600) using the **publishable** key, not the service-role key. **Rotate the database password** — it was pasted into a chat transcript.

**Verification:** typecheck, lint and production build green. In-browser: `競品` returns the Chinese fixture (previously zero), tags render with the two-tier split, adding a tag files it under the owner's list, rejecting an AI tag writes a correction visible in /memory. **Not verified:** the no-API-key degradation path — the dev server belongs to another session and could not be restarted with a different environment.

## Loop 13 — Vercel deployment
**Date:** 2026-08-01 · **Phase:** P1 · **Outcome:** deployed to a protected preview; production deliberately not promoted

Project `capso` created under `vibe99s-projects` and auto-connected to `github.com/ekcheungAI/capso`, so pushes to `main` will deploy from now on. Root Directory set to `apps/web`; no `vercel.json` — settings live on the project, which is the standard monorepo setup and avoids a second source of truth.

**Bug found by deploying.** The first two builds failed, and the second failure was real: `apps/web/pnpm-workspace.yaml`, a `create-next-app` leftover committed in loop 01, contains only `ignoredBuiltDependencies` and no `packages:` key. With Root Directory at `apps/web`, pnpm walked up, found *that* file first, and concluded the workspace had zero packages — so `@capso/shared@workspace:*` could not resolve. It also contradicted the root's `onlyBuiltDependencies` and was the cause of the "Next.js inferred your workspace root, but it may not be correct" warning on every local dev start. Removed; local install and build re-verified.

**Production is not promoted, on purpose.** Three routes ship without authentication: `/api/ingest` accepts POST from any origin (`access-control-allow-origin: *`), `/api/classify` spends the MiniMax key on any image handed to it, and the app itself has no sign-in. Vercel Authentication covers this — but on the Hobby plan it is available for **preview deployments only** (`invalid_sso_protection` on production). So protection is enabled for previews and the production URL (`capso-cyan.vercel.app`) is left unbuilt rather than exposed.

Verified against the live preview: `/` → 302 to Vercel SSO, `/api/classify` → 302, **`/api/ingest` POST → 401**. Nothing reachable without the owner's Vercel login.

Env vars set on the preview environment via the REST API rather than `vercel env add --value`, which would have put the MiniMax key in argv: `MINIMAX_TEXT_API_KEY`, `MINIMAX_API_BASE_URL`, `MINIMAX_MODEL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

**Before production is possible:** either a plan that protects production, or real auth on the two API routes plus a replacement for the in-memory ingest queue — a module-scope array cannot work across serverless instances, so the extension bridge is unreliable in production regardless of protection.

## Loop 14 — The library stops hiding its contents
**Date:** 2026-08-01 · **Phase:** P1 · **Outcome:** phases A + B done; C (review sweep) and D (image pipeline) still open

Owner imported 9 real screenshots and got a library reading `9 captured · 0 filed across 0 projects · 9 waiting`, five shelves all saying *"Nothing here yet — drag a capture onto this row"*, and one `Importing 4/8…` pill. Four pieces of feedback; every one of them turned out to be a spec that was written and never built.

**The captures were never lost — nothing rendered them.** `results` was derived from `filed` (`threadId !== null`), and shelves rendered `results.filter(s => s.threadId === t.id)`. An unconfirmed capture appeared in no shelf, no month group and no intent group; Months/Intent showed *"These filters exclude everything you've saved"* with **no filter active**. Shelves now partition on `threadId ?? suggestedThreadId`, so a capture sits in the project Capso thinks it belongs to, marked unconfirmed, with an inline **✓ Keep here / Change / N%** chip — which is what `15_DESIGN_SYSTEM_AND_UX.md` line 51 specified all along ("the chip IS the call to action"). Confirming routes through the same `assignThread` as the Inbox, so the correction ledger stays whole regardless of which surface you used.

**Added an Unsorted shelf.** Captures with neither a project nor a guess previously existed in the database and on no screen at all. Now nothing can be invisible.

**Two silent bugs, both invisible before this loop:**

1. **`0 projects` was a labelling bug.** `LedgerStrip` was passed `threads.filter(t => byThread(t.id).length > 0).length` — projects *in use*, not projects that exist. With everything unconfirmed it read 0 and looked like the starter kit had failed. Now counts projects that exist, and the phrase is "N confirmed in M projects" rather than "filed across".
2. **An exact project-name match was destroying routing.** `threads.find(t => t.name === result.project_suggestion)` meant `Marketing and hooks` did not match the starter kit's **`Marketing & hooks`** — and a null suggestion does not merely lose the auto-file, it strips `suggestedThreadId`, so the capture landed unfiled *and* counted by no shelf. Replaced with a three-tier match (exact → normalised → connective-stripped, the last only when unambiguous), and every fallback is logged. Verified against `Marketing and hooks`, `Marketing—hooks`, `marketing hooks`, `Q3 Launch Campaign`, `Bugs to fix.`, trailing whitespace — all resolve; genuine non-matches still return null.

**Contradictory rows can no longer be written.** `threadId` and `assignmentSource` were computed from two separate expressions, so a high-confidence result whose name failed to match produced `assignmentSource: "auto"` with `threadId: null` — a row claiming to be auto-filed while sitting unfiled. Both now derive from one `filedTo` value.

**Confidence is calibrated.** The prompt described exactly one threshold — *"use null and a confidence below 0.5"* — so the model was never told what 0.8 meant and clustered at 0.75, which is why nothing auto-filed. It now states what each band causes, and that an obvious match should say 0.9. **Not yet measured against the real model** — needs a fresh import to confirm the distribution actually moves.

**In-flight captures are visible.** The image now appears in the grid the moment it is read, with the thin progress edge on the thumbnail that `05_FEATURE_SPEC_CAPTURE.md` §2 specified, a muted "Analysing…" title, and dragging disabled until it has been classified. Satisfies AC-CAP-04's "appears immediately with a processing state". The sweep uses `--ease-in-out-strong`, a token that had been declared and never referenced; it degrades to a static edge under `prefers-reduced-motion` rather than looping.

**Verification:** typecheck, lint, production build green. In-browser against the seeded library with 3 captures forced unconfirmed, 1 orphaned and 1 left processing: ledger read `13 captured · 5 confirmed in 4 projects · 8 waiting`; shelves rendered their unconfirmed cards instead of "Nothing here yet"; clicking **Keep here** filed the capture, wrote a `Correction` with `wasAiAccepted: true`, and removed the chip; the processing card rendered with a running `capso-progress-sweep` and `draggable="false"`; Unsorted held 2. Fixtures restored afterwards.

**Still open:** Phase C (post-import review sweep) and Phase D (WebP 800px thumbs, extension bypassing `downscale` at 3–11 MB/row, and `loadAll` pulling every base64 image into React state). Storage numbers in the plan are estimates and are to be **measured, not asserted**, when D lands.

## Loop 15 — Review sweep + image pipeline
**Date:** 2026-08-01 · **Phase:** P1 · **Outcome:** done — plan phases C and D complete

**Confidence calibration is confirmed working against the real model.** Loop 14 changed the prompt to state what each band causes and flagged the result as unverified. A capture through the real MiniMax path now returns `confidence: 0.97` and auto-files (`assignmentSource: "auto"`, `threadId` set). Previously scores clustered at 0.75 and nothing crossed 0.8. That was the outstanding caveat; it is closed.

**Review sweep — `/review`.** Every capture Capso has a guess for but no confirmation on, ordered **most-confident first** so the run of easy yeses comes before the judgement calls. Thumbnail, title, intent, confidence bar, `✓ Keep in <project>` and a "Somewhere else…" dropdown that omits the already-suggested project. `Keep all N` at the top. Keyboard is the Inbox's existing idiom — `j`/`k`/`⏎`/`1–N` — rather than a second triage vocabulary. Offered by the post-import toast at ≥3 captures and by the library banner at ≥3; below that, confirming on the cards is faster than opening a screen. Verified: 8 captures confirmed in one click, `user_corrections` went 2 → 10, all `wasAiAccepted: true`, and /memory reports the window feeding 10 of 10.

The toast gained an optional action label (defaulting to "Undo") so the import toast can offer "Review" — the useful next step after an import is looking at what landed, not undoing it.

**Image pipeline.** `downscale()` now emits two variants from one decode: the ≤1600px JPEG original and an **800px WebP q80 thumb** (doc 14 §25), encoded by canvas with no dependency. `imageFor(s, "thumb" | "full")` routes grids, sidebar, filmstrip, capture overlay and citation chips to the thumb; only the detail hero, zoom, copy and download touch the original. Real `width`/`height` are stored — `downscale` had been computing and discarding them, keeping only the three-bucket `aspect`, which is not enough to reserve layout space. `Thumb` gained `loading="lazy"`, `decoding="async"` and intrinsic dimensions.

**`start()` now takes a processed image, not a data URL.** This is what stops a path from skipping the pipeline: the extension used to hand its raw `captureVisibleTab` PNG straight in. All four entry points — import, extension, paste, Capture button — go through `downscale` by construction.

**Measured, not asserted** (synthetic 2560×1600 retina screenshot with realistic entropy — antialiased text at mixed sizes, gradients, a noisy photo region; a flat-colour test image compresses unrealistically well as PNG and gave a meaningless first reading):

| | before | after |
|---|---|---|
| Extension capture, stored per row | 4,197 KB raw retina PNG | 268 KB (full + thumb) — **15.7×** |
| Grid render, per card | 220 KB | 48 KB — **4.6×** |

The grid ratio is content-dependent: a flatter, more typical UI screenshot measured 17×. Treat 4.6× as the pessimistic end, not the headline. A real end-to-end capture produced a 27 KB original and an 11 KB WebP thumb with `width: 900, height: 560` — a small gap only because the sample capture is already under the 1600px cap.

Safari before 16 has no canvas WebP encoder and `toDataURL` silently returns PNG when the type is unsupported, which would make the "thumb" larger than the original; the code detects the returned MIME type and falls back to a small JPEG.

**Not done:** plan item D4 — `loadAll()` still reads every row with its full base64 original into React state. Thumbs cut what the grid *renders*, not what the store *holds*, so the ~200 MB-at-500-captures figure stands. Fixing it means moving `imageDataUrl` to its own object store with an on-demand read, which is a `DB_VERSION` bump and a data migration. Deliberately left for its own loop rather than bolted onto this one.

## Loop 16 — Originals leave the row (plan item D4)
**Date:** 2026-08-01 · **Phase:** P1 · **Outcome:** done

Loop 15 shipped thumbs and said plainly that they cut what the grid *renders*, not what the store *holds* — `loadAll` still read every row with its full base64 original into React state. This closes that.

`DB_VERSION` 2 → 3 adds an `images` object store keyed by screenshot id. `putScreenshot` writes the original there and nulls it on the row; `getImage(id)` reads it back for the two surfaces that need it — the detail view (hero, zoom, copy, download) and the Inbox's re-classify. `deleteScreenshot` and `resetAll` cascade, or the heaviest part of a capture would be orphaned and unreachable.

**The split is conditional on a thumb existing.** A capture taken before thumbs would have nothing left to render in the grid, so those keep their original inline — the old behaviour, which is correct for them — and age out. The v2→v3 migration applies the same rule inside the versionchange transaction, so an existing library migrates exactly once rather than half-migrating on first write.

`imageFor` falls back original → thumb → placeholder, so a detail view that has not finished loading shows the 800px version rather than a wireframe over real content.

**Verified against a real library:** DB reports version 3 with the `images` store present, the one real capture's 27 KB original moved out, rows now carry **0 KB of originals and 11 KB of thumbs**, and the detail view renders correctly from the separate store. The saving is per-capture and compounds: list state now holds N thumbs instead of N originals.

**Two fixes made on the way:**

- The detail file-meta line read `PNG` for every capture and sized it from the row. The import path encodes JPEG, so that label had been wrong for every real capture since it shipped. Now reports the actual MIME type, the true pixel dimensions, and the loaded original's size — `JPEG · UI SCREEN · 900×560 · 27 KB`.
- The first version of the on-demand load reset state synchronously inside the effect, which the React Compiler lint correctly rejected as a cascading render. Rewritten to key the loaded image by capture id, which also closes a window where the previous capture's original could show under the new title.
