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

## Loop 17 — Phase 0: stop corrupting data
**Date:** 2026-08-01 · **Phase:** P1 · **Outcome:** done

A three-way audit (extension readiness, functional gaps, experience) surfaced two data-integrity bugs that had to land before extension work, because making the extension real multiplies the captures flowing through this exact pipeline.

**Every failed classify was writing fabricated metadata into a real capture.** `classify.ts` was `if (res.ok) { … }` with no `else`, so any 502, network error or unparseable body fell into `simulated()` — one of three hardcoded rows selected by `imageDataUrl.length % 3`, **including invented `ocrText`**, at `confidence: 0.86`. That clears `AUTO_ASSIGN_MIN`, so the capture auto-filed itself into a **randomly chosen project**. The `simulated` flag lived only in memory, so nothing downstream could tell; the invented text went into the search index and was quoted back by chat as fact. `status: "unprocessed"` had been declared in the type since loop 03 and was never written by any code path.

Now split three ways: **503** (no key) is a deliberate demo mode and still returns canned output, but the row is flagged `simulated` and says "Sample data" on the card and in the Inbox. **Any other failure** returns `failed()` — honest empties, `confidence: 0` so nothing can auto-file, `status: "unprocessed"`, surfaced as "Couldn't be read — try again". Verified across 200/401/500/502/503/network-throw: only 503 produces canned text, only a real 200 auto-files.

**Classification was overwriting concurrent user edits.** The second write was a whole-object `put` rebuilt from the pre-classify snapshot, hardcoding `userTags: []` and `archived: false`. Anything done during the classify window — up to 60s — was silently destroyed, which is exactly the window in which the overlay invites Confirm. Replaced with `patchScreenshot`, which re-reads the row and merges only model-owned fields. It takes an optional function so the caller can decide *based on current state*: `why_saved` and `intent` are the model's guesses but the user's to correct, so if the user got there first their answer wins.

**Verified live, not reasoned about.** Fired a real capture, wrote `userTags`, `archived`, `whySaved` and `intent` while `status === "processing"`, then waited for the model: all four survived, and the model's title, tags and confidence still landed. Before this change all four were destroyed.

**Also:** `classify` gained an `AbortSignal.timeout` — a hung connection used to park a row at `processing` forever with no recovery but deletion. The Inbox re-read now patches instead of writing a full object, so `status` actually moves; without it a re-read capture stayed "Analysing…" permanently, undraggable and invisible to `/review`. And Inbox **Confirm is disabled when there is no suggestion** — it used to assign `null → null`, a visible no-op that still wrote a correction teaching the model to file into Inbox.

**Next:** Phase 1, the extension — direct-to-Supabase, image processing moved into the service worker, and `/api/ingest` deleted along with its in-memory queue and `access-control-allow-origin: *`.

## Loop 18 — Extension: compress at source, configurable endpoint, and a closed CORS hole
**Date:** 2026-08-01 · **Phase:** P1 · **Outcome:** done — but the transport swap is blocked, see below

**Blocker found before starting.** Phase 1 of the plan was "extension writes direct to Supabase". The web app has **no Supabase client, not even a dependency, and no auth surface** — the store is pure IndexedDB. An extension writing to Supabase would put captures where the app cannot read them. Direct-to-Supabase is therefore gated on the web app's own store migration, and is now recorded as such in `specs/api_contracts.md`. Everything below is correct in every future architecture, so it was done first.

**Security: `/api/ingest` was readable by any site.** `cors()` returned `access-control-allow-origin: *` on **every** response including the `GET` that drains the queue, so any page the user visited could read the full base64 of screenshots taken from their private tabs, or push forged captures in. The comment directly above it read "allow only the local app". Now only `chrome-extension://` origins get a header at all, and only for `POST`/`OPTIONS`; the drain is same-origin.

**Captures are no longer destroyed on read.** `GET` used to `splice` the queue, so a throw part-way through the client's loop — or the tab closing — lost every remaining item from both sides silently. Items are now held in-flight and confirmed with `POST { ack: [...] }` once genuinely stored; anything unacknowledged for 60s is re-offered. A full queue answers **507** instead of evicting silently and still reporting 200, which had the extension saying "Sent to Capso" for a capture it had thrown away.

**Compression moved into the service worker.** `captureVisibleTab` returns an uncompressed retina PNG: ~4.1 MB, **5.46 MB base64 — over Vercel's 4.5 MB body cap**, so the extension could never have worked against a deployment. It now downscales to ≤1600px JPEG via `OffscreenCanvas` + `convertToBlob` before sending: ~293 KB on the wire. The app's own `downscale` ran *after* receipt, which is too late to help.

**The endpoint is configurable.** `CAPSO_ORIGIN` was hardcoded in `background.js` and a second time in `popup.js`. Now stored in `chrome.storage.local`, set from a new options page, with Chrome host access requested for that origin at save time from `optional_host_permissions` rather than shipping a wildcard.

**The download page 404'd on every deployment.** `.vercelignore` excluded `apps/extension` and `scripts/`, and the zip plus `extension-version.json` are gitignored build artefacts — so `/capso-extension.zip` never existed in production and the update check silently no-opped forever. The web build now runs `build-extension.sh` first, which fails loudly if `zip` is absent rather than shipping a broken download. Verified: 11 files, 16 KB, v0.2.0.

**Manifest.** Full icon set (16/32/48/128) plus `action.default_icon` — only `icon128` existed, which is why Chrome showed a generic letter tile; the PNGs come from the brand work in `drafts/brand/mark/out/`. Added `options_ui`. Version to 0.2.0.

**Smaller fixes:** every non-OK response used to report "Capso isn't running", including a 507 and a 500; the popup reimplemented the update check with a `!==` compare that flagged a *newer* local build as outdated, and built its link with `innerHTML` from a now user-configurable origin — rebuilt as a DOM node; `chrome.notifications?.` guarded a declared permission; an unknown message type closed the port silently so the popup reported a bare "Failed."

**Specs.** `api_contracts.md` gained the extension section it never had, and `extension` was added to the `source` enum — the extension had been sending it since loop 10 while the contract disagreed. `permission_model.md` gained an extension threat model, including the honest statement that blur-before-upload is the only pre-cloud redaction control and the extension has no annotation surface, so browser captures reach the classifier unredacted.

**Still not verified:** loading the extension in a real Chrome. Every previous loop said the same; it needs a human at a browser.

## Loop 19 — Design review, and the ten quick wins it named
**Date:** 2026-08-01 · **Phase:** P1 · **Outcome:** done — review written, all ten `[today]` items shipped

A combined UX/AI and capture-parity review was run against the repository rather than against a description of it, and is written up in `drafts/2026-08-01_capso-design-review.md`. Four findings reframed the brief before any of it was useful: there is no landing page (`app/page.tsx` is the authenticated library), there is no Mac app (`apps/mac/src/App.tsx` is fifteen lines that capture nothing), there is no semantic search or background processing, and "capsules"/"racks" exist nowhere in the code — which already runs three names for one concept, so the review recommends against adding a fourth in-product and keeping the metaphor to the mark and marketing.

The review's roadmap is gated on the store migration. Everything below is from the ungated half.

**Search had two engines, and the one people use was the worse one.** The ⌘K palette carried its own AND-of-substrings filter over six fields — no `Intl.Segmenter`, no ranking, no reach into `userTags` or `pageTitle` — so a 繁體中文 query that worked on `/search` returned nothing in the palette. It now calls `retrieve()`. One engine, one ranking.

**Three defects in `retrieve()` itself, all now covered by checks that failed before the fix.** Matching was raw `hay.includes(w)`, which scored "cat" against "duplicate" and "design" against "redesigned"; Latin terms now match at a word start, with prefix matching kept deliberately as the cheapest stand-in for stemming, and CJK keeping substring matching because there is no boundary to anchor between two Han characters. A field added `weight` **per matching word**, so a verbose query let one long OCR blob outrank an exact title match; a field now contributes at most its own weight, scaled by query coverage. And the cutoff was `score > 2` — numerically identical to the maximum recency bonus, so it excluded non-matches by coincidence and would have started leaking them the moment either constant moved; the gate is now "matched at least one field".

**The revisit term was specified, populated, and had no consumer.** `08 §5` weights the ranker `0.55 semantic / 0.25 keyword / 0.10 recency / 0.10 revisit`. `revisits` rows have been written on four event kinds since loop 03 and were read only by `/memory`'s resurface tab. Wired in, log-scaled and saturating at eight, alongside recency moved to the specified `exp(-age/90)`.

**The resurfacing shelf exists.** `GUIDELINES.html` specified it down to "no badge, no count, no red dot", `/memory` already computed the candidates, and it had never been built — which left the brand's second clause ("the rack holds everything, Capso knows which one to pull") entirely unimplemented. `lib/resurface.ts` returns a reason string per candidate and there is **no code path that produces a candidate without one**, because a recommendation the user cannot interrogate is one they can neither trust nor dismiss. Nothing younger than 14 days is eligible, so the shelf is genuinely empty most days rather than being a backlog; failed classifications are excluded, since surfacing a capture with no summary and no OCR text would be showing the user an unreadable card and calling it a suggestion. Renders nothing at all when empty.

**`/review` was unreachable below three pending captures.** It was gated at `inbox.length >= 3` on the library banner and `landed >= 3` on the import toast, with no nav entry — so two pending suggestions could not reach the sweep, and dismissing the toast closed the only other door. Now in the sidebar; the banner routes on whether there is anything sweepable at all rather than on an arbitrary three.

**The product was unusable on a phone.** The sidebar was `hidden md:block` with nothing replacing it, so Inbox, Search, Memory, every project and "+ New project" were unreachable below 768px. Shown as a drawer rather than duplicated into a bottom bar — one source of navigation, and no collision with the capture buttons pinned bottom-right. It closes on the link groups rather than on the whole panel, because "+ New project" lives in there and must survive being focused.

**`EmptyState`'s action slot was not actionable.** It rendered as bare accent text at eight call sites, so "Back to the library" looked exactly like a link and did nothing — `/review` had added a second real link underneath to compensate. Now a `ReactNode`; `/review`'s workaround is gone and the library's two filter empty states carry real controls.

**Smaller, from the same review:** one focus-visible ring for the whole app, where exactly one had existed (`palette.tsx`) on a product whose triage flow is keyboard-first — plus the card summary now revealing on focus as well as hover. A `?` keyboard reference, since every binding was taught only in place and a user who never opened the Inbox never learned the product had a keyboard. One model-status string instead of three, two of which printed `MINIMAX_TEXT_API_KEY` at the user — error-code language at the surface, which `15 §UI tone` puts in tooltips and logs. And the filing verbs unified to Confirm / Move to… / Try again across the Inbox, Review, the card chip and the overlay, executing the decision recorded at `15:140`; the doc's own mapping named "Reclassify" for the third, and the shipped "Try again" was kept because the same doc calls it the cheap escape hatch that stops a wrong suggestion feeling like a dead end.

**`15_DESIGN_SYSTEM_AND_UX.md:36` contradicted its own token table** — "Single accent color" against `Accent | **None.**` thirty lines below. Reversed in place with the reasoning recorded rather than deleted, per loop 12a.

**Test infrastructure, minimally.** There was none. `22_TEST_PLAN.md` names Vitest, but the two pure modules here needed no framework: `lib/*.check.ts` run under `node --experimental-strip-types --test`, which required `allowImportingTsExtensions` (safe under `noEmit`) and moving `INTENT_LABEL` out of `components/ui.tsx` into `lib/intent.ts` so the retriever no longer imports a React module to reach a label map. `ui.tsx` re-exports it, so no call site changed. 13 checks; one of them caught a wrong assertion of mine about ICU segmenting 定價頁, not a bug in the code.

**Verified:** `pnpm typecheck`, `pnpm lint`, `pnpm test` (13/13) and `pnpm build` all green, and every change exercised in the browser at 1280px and 375px — shelf with three distinct reason lines, ⌘K returning ranked results, `?` opening and closing, the drawer opening and dismissing on navigation, `/review` reachable with an empty inbox, and no console errors.

**Not done, and named as needing a human:** the extension still has never been loaded in a real Chrome — which matters now, because the review's next two capture items (area select, in-page post-capture overlay) build on code nobody has run. The tray icon is still unverified, on the same permission surface P2 depends on.

## Loop 20 — First production deploy, and the extension page that was unreachable
**Date:** 2026-08-01 · **Phase:** P1 · **Outcome:** done — live at https://capso-cyan.vercel.app

Loop 13 deployed to a protected preview and deliberately did not promote, because three unauthenticated routes were reachable. Re-checked before promoting: all three now carry origin guards (`/api/chat` and `/api/classify` same-origin, `/api/ingest` `chrome-extension://` for capture and same-origin for ack, from loops 17–18), and **no environment variables are set on the Vercel project at all** — so `MINIMAX_TEXT_API_KEY` is absent, `/api/classify` answers 503, and the deployment runs in the flagged sample-data mode with no paid endpoint to abuse. Production it is. Preview was the wrong target regardless: SSO protection is on for preview, which would 401 the extension's service-worker POST and make the bridge untestable.

**`/extension` was unreachable on any fresh browser.** The `needsSetup` takeover in `shell.tsx` is route-independent — it returns the starter-kit picker instead of `children` for every route — so the page telling a new user how to install the extension was replaced by a question about which projects to create, with no way through. Found by opening the deployment, which is a fresh origin and therefore a fresh IndexedDB; it cannot reproduce on a dev machine that has already run setup. `/extension` is now exempt: it is a static download page that depends on no library state.

**The extension had no way to know where to send captures.** It ships defaulting to `http://localhost:3000` and the install guide never mentioned changing it, so a copy downloaded from a deployment would post to a dev server that is not running — and `background.js` reports "Sent to Capso" on the way out either way. The guide gained the step, rendering the origin it is actually served from rather than a hardcoded one, so it stays correct on localhost and on any deployment. Read with `useSyncExternalStore` rather than an effect: the page is prerendered, so the origin cannot be read during render without a hydration mismatch, and it is a constant rather than state.

Also added the step that Capso must be open in a tab, which is a consequence of the bridge design and was documented only in `apps/extension/README.md`.

**Verified against the deployment, not the dev server:** `/` 200, `/extension` 200 and rendering without the setup takeover, `/extension-version.json` serving `0.2.0`, and `/capso-extension.zip` downloading — 200, `application/zip`, 19,234 bytes, 12 files, valid archive. That last one is the first time it has ever worked in production; it 404'd on every previous deployment until loop 18 fixed `.vercelignore`.

**Known-unreliable in production, unchanged by this loop:** `/api/ingest` holds its queue in a module-scope array. On serverless that is per-instance, so a capture posted to one instance is invisible to a poll served by another. With one warm instance it will usually work and it will sometimes silently drop — the durable endpoint arrives with the store migration. **Still never loaded in a real Chrome**; there is now a URL to load it against.

## Loop 21 — Real classification in production, and a capture guard that refused too much
**Date:** 2026-08-01 · **Phase:** P1 · **Outcome:** done

`MINIMAX_TEXT_API_KEY` is now set on the Vercel project (production, encrypted) and `/api/classify` reports `{"configured":true,"model":"MiniMax-M3"}`. Verified end to end against the deployment rather than inferred: a capture fired on the live site came back with a model-written title, no `Sample data` pill — so `simulated: false`, a real call — and auto-filed itself into *Design inspiration* above the 0.8 band.

**The key was pasted into a chat transcript and must be rotated.** This is the second time; the standing note from loop 12b says the same about the previous one and the Supabase password. Rotating it means re-running `vercel env add` and updating `.env.local`.

**Consequence now live, and it is the one loop 13 was avoiding.** With a key present, `/api/classify` and `/api/chat` spend real money on a public origin. Both are same-origin guarded, which stops a browser on another site, but an `Origin` header is trivially forged by a non-browser client — the guard is a CORS control, not authentication. Options are Vercel Authentication on production (which would also break the extension bridge, since SSO 401s the service worker's POST), a shared secret on the two model routes, or accepting the exposure until auth lands with the store migration. Recorded rather than decided.

**`captureActiveTab` refused on tabs whose URL it could not read.** The guard was `!tab.url || /^(chrome|edge|about|devtools|view-source):/`, so a missing URL — which means activeTab has not been granted yet, not that capture is blocked — produced the same "Chrome blocks capture on this page." as a genuine policy block. Now only the known-blocked schemes short-circuit; anything else is attempted and Chrome's own error is surfaced, which is both more accurate and what reveals the real reason on the Web Store (https, blocked by policy rather than by scheme). Message reworded to say what to do. Extension to v0.2.1, so installed copies get the update notification.

**Reachability fix carried from loop 20 confirmed in the wild:** the deployment is a fresh origin and therefore a fresh IndexedDB, which is exactly the state that exposed `/extension` being replaced by the setup picker. Neither that nor the wrong-origin default could have been caught on a dev machine.

## Loop 22 — The extension could succeed and look identical to failing
**Date:** 2026-08-01 · **Phase:** P1 · **Outcome:** done — v0.2.2

Reported as "the extension doesn't seem to do anything", with the popup still reading the v0.2.0 string, so the first finding is that the reloaded build had not been picked up. The rest is real.

**The hotkey path had exactly one way to report anything, and macOS can switch it off.** `captureActiveTab` reported success and failure solely through `chrome.notifications`, which the OS suppresses entirely unless Chrome is permitted to notify in System Settings. With them off — the default for a freshly installed browser — a capture that worked and a capture that failed were both silence, from a path where the popup is not open to show anything. Now every outcome is written to `chrome.storage.local.lastResult` and raised as an action badge (`✓` / `!`), which needs no permission and cannot be silenced; opening the popup reports the sentence and clears the badge. Badge text only, no background colour: a service worker cannot read the CSS custom properties the rest of the extension is styled from, and `pnpm brand:check` correctly rejected the hardcoded pair that was there first.

**The popup could report a failure without revealing any of the things that cause one.** It showed a button and a string. It now states the destination origin and the current tab's address, which are precisely the two facts that distinguish "pointed at a dev server that is not running" from "aimed at a tab Chrome will never allow" — and it is the second of those, silently, that produced every report so far.

**The refusal now names the page.** `Chrome blocks capture on this page.` is true and useless. It reads `Chrome won't allow capture on chrome: pages. Switch to an ordinary tab and try again.`, built from the tab's actual scheme, and `chrome-extension:` was added to the list — loading an unpacked extension leaves the user on `chrome://extensions`, which is exactly where they will first click it.

**Verified what can be verified without a browser:** the deployed `/api/ingest` accepts a POST carrying `Origin: chrome-extension://…` (200, `{"queued":1}`), refuses the same POST from `https://evil.example` (403 — the CORS hole from loop 18 stays closed), and returns the item to a same-origin poll carrying `x-capso-poll`. The probe was acked afterwards so it did not land in the library. So the server half of the extension path is correct on production; everything remaining is on the Chrome side.

**Unchanged and still the likeliest cause of a capture vanishing:** the queue is a module-scope array on serverless, and captures are only ever collected by an open Capso tab. Capturing with every Capso tab closed puts the image somewhere nothing will read it.

## Loop 23 — The library opens as a gallery
**Date:** 2026-08-01 · **Phase:** P1 · **Outcome:** done

**Reverses the loop-12a default of project shelves,** recorded rather than quietly flipped. Shelves are the right way to show that filing happened, but they answer a question you only have once the library is full, and they pay for it by splitting the collection into rows that are mostly empty and mostly below the fold. Reported from a real library with a starter kit and no captures yet: five headings all reading "Nothing here yet", which is five statements of absence where one belongs, and a front page showing its filing cabinet instead of the screenshots — the inverse of principle 5. `Gallery` is now the first grouping and the default: everything that survives the filters, newest first, undivided. Projects / Months / Intent are unchanged and one click away.

The zero-capture case now renders one empty state instead of N empty shelves, and it points at `/extension` rather than restating the drop hint.

**Diagnosing a capture that never arrived, in passing:** both ingest queues — production and the dev server on :3000 that the extension still defaults to — were empty, and no `source: "extension"` row exists in any library. So the capture failed inside Chrome before the fetch, which is precisely the silent path loop 22 fixed and which the reporting build predates.

**A hazard worth naming, because it was self-inflicted.** The queue is drain-once, so *any* open Capso tab collects captures into *its own* IndexedDB — including a verification tab opened by an agent against the same deployment. Two were open during this session. Nothing was actually taken (the only row in that library was a synthetic capture made locally, `source: "hotkey_region"`), but it could have been, and a user running Capso in two browsers would hit the same thing with no explanation. Another consequence of the module-scope queue that the store migration removes.

## Loop 24 — Tags become an axis, and the classifier stops reinventing them
**Date:** 2026-08-01 · **Phase:** P1 · **Outcome:** done

Owner observation: projects are not always the right shape, and categorisation should cost as close to nothing as possible. Correct, and the schema already agreed — `tags` and `userTags` are on every row, `userTags` is weighted 4 in `retrieve()` (tied with title for the strongest signal there is), the classifier emits tags on every capture, and none of it was navigable from anywhere but the detail page.

**The distinction that makes this worth doing.** A project is a *destination*: one per capture, mutually exclusive, must exist before anything can go in it. That exclusivity is what creates a filing decision, and the decision is what creates the Inbox and Review backlog. A tag is a *facet*: many per capture, nothing displaced by adding one, so being wrong costs nothing and there is no queue. The friction is exclusivity, not categorisation.

**Vocabulary reuse, which is the whole reason this can work.** Left alone the model writes "pricing", "pricing page" and "pricing table" for three captures of the same thing, and a filter over that is worse than no filter — every facet holds one item and none is the one you want. `lib/tags.ts` derives the library's existing vocabulary (excluding singletons — a tag seen once is not vocabulary, and offering it back would cement whatever the model said first), and it now travels with every classify call, sanitised and capped at 60, with a prompt rule to reuse verbatim and only coin a tag for a genuinely new subject. Same mechanism the correction ledger already applies to projects (06 §6), applied to the axis that had none.

Verified with a real capture against the live model: five tags, including **繁體中文** reused verbatim from an existing row rather than coined as "traditional chinese". The tag cap rose 8 → 12, since eight was set when tags were decoration on a detail page rather than the way you navigate.

**A fourth filter, against the tripwire in 15 §reference board** — which permits one when a real query fails without it. This is that case: a capture belongs to exactly one project but is about several things, and "the pricing screens, whichever project they landed in" could not be asked. Tags are now a filter, and the chips on each card are buttons that set it — rendered outside the card's `<Link>` for the same reason the confirm row is, and revealed on hover or focus so the resting card stays just the screenshot.

**Not done and worth naming:** tags are still absent from the sidebar, so there is no way to *browse* the vocabulary without opening the filter, and existing captures keep whatever tags they were given before the vocabulary existed — a reconciliation pass over the back catalogue is the obvious follow-up and is not in this loop.

## Loop 25 — The extension becomes the durable store; the relay stops needing to be one
**Date:** 2026-08-01 · **Phase:** P1 · **Outcome:** done — extension v0.3.0

Owner asked whether to push the extension toward CleanShot parity and start planning a Mac app. Yes to both, but neither was next: a single capture has still never reached the library, and the transport underneath could lose or misdeliver one even with a perfect client. Loops 21–23 each produced a different confident diagnosis of the same symptom from reading code — that is a missing feedback loop, not a bug backlog, and every capture mode added on top multiplies a debugging surface that already cannot be bisected.

**The plan called for Vercel Blob to make the relay durable. Inverted instead, and it needs no new infrastructure.** The durability now lives in the extension, which holds every capture in its own IndexedDB and re-sends until the web app confirms it stored it. The relay stays a module-scope array — per-instance, gone on recycle — and that is *fine*, because losing it costs a re-send rather than a capture. Three properties make it safe, all verified against production: ids come from the client so a retry is the same capture rather than a second capsule; items are addressed to a device so a poll drains only its own; and confirmation is explicit, so an instance that recycles and forgets simply causes one more upload, which the web app dedupes.

Corrects the comment at `api/ingest/route.ts:5-7`, which claimed a service worker cannot write to IndexedDB. It cannot write to *the web app's*; it can write to its own — and that imprecision is what justified the in-memory design in the first place.

**The cross-tab theft hazard is closed at the contract level.** An unaddressed capture is refused with 400 rather than defaulted, and a poll without a device is refused too. Previously any open Capso tab in any browser — including a verification tab an agent opened against the same deployment, which happened twice in loop 23 — silently collected everything. Pairing is a device code shown on `/extension` and pasted into the extension's options next to the origin.

**Two guaranteed-loss paths removed.** A compress failure used to fall through and post the raw ~5.5 MB base64 PNG with a comment saying the app would downscale it on receipt — it cannot, that body is over Vercel's 4.5 MB limit and never lands. And 507 was terminal, destroying the capture the relay had just refused; it is backpressure now, and the item stays queued.

**`sourceApp` is written for the first time.** The column has existed since loop 03 with no producer, so "the screenshot from Notion" had nothing to match against. The extension now sends the capture's hostname, and `width`/`height` too — both were null on every extension capture despite the web app using them to reserve layout.

**Feedback that survives the OS, continued from loop 22.** The badge shows a pending *count* rather than a glyph: "3" says captures are waiting and roughly how badly, where "!" said only that something once went wrong. Retry is `chrome.alarms`-driven, because an MV3 worker holding a `setTimeout` is a worker that has been killed.

`background.js` split into `config.js` / `capture.js` / `outbox.js` with a module service worker, before it grew a fourth capture mode into a single file.

**Verified against production, not reasoned about:** unaddressed POST → 400; poll without device → 400; and against the dev server, the full convergence loop — valid POST queues, re-send while queued returns `duplicate` without requeuing, re-send while in-flight likewise, wrong device drains nothing, right device gets the item with `sourceApp` and `width`, and after ack a re-send returns `confirmed` so the outbox retires it. `pnpm typecheck && lint && test (18) && build` green.

**Still the owner's, and still blocking:** loading the extension in a real Chrome. It has never been done, and P2 (area select, context menus, the in-page overlay) builds directly on code nobody has run.

## Loop 26 — The popup diagnosed itself, and the answer was a preview URL
**Date:** 2026-08-02 · **Phase:** P1 · **Outcome:** done — extension v0.3.1

First report from the v0.3.0 popup, and it worked as designed: *"2 waiting to reach Capso / Sends to http://localhost:3000 / This tab capso-git-feat-memory-layer-and-library…"*. Three facts, and between them the whole diagnosis — the address was never changed off the default, and the tab in front of the owner was a **git-branch preview deployment**, which `ssoProtection` covers. Confirmed rather than assumed: the preview answers `401 {"error":{"code":"401","message":"Protected deployment"}}` to `/api/ingest`, while production answers `200`. So both candidate addresses were wrong, one silently.

**The two captures were not lost**, which is the outbox earning its keep on its first real failure. They sat in the extension's IndexedDB across the misconfiguration and drain once the address is right.

**A footgun worth naming: the device code is `localStorage`, and `localStorage` is origin-scoped.** The code shown on the preview URL is a different code from the one on production, so copying the address from one page and the code from another produces a pairing that cannot work. `/extension` now states which address its code belongs to and says to take both from the same page.

**Three fixes so this class of failure reports itself:**
- The options page **probes the address before saving** — 401/403 says "that address asks for a login, use your public Capso address, not a protected preview"; 404 says it does not look like Capso; unreachable says so. A wrong address used to be discoverable only by taking a capture and watching it not arrive.
- The outbox names a 401 rather than reporting "Capso responded 401", because the fix is an address change and nothing about a 401 says so.
- The popup shows **"Open settings to fix this"** when anything is pending, and only then — a queue that is not moving is almost always a wrong address, and the fix lives on a page most people do not know exists.

Verified: all six extension files parse as ES modules under `node --check` (the module split in loop 25 was never checked this way — the earlier check regex stripped `export async function f() {` including its brace and reported three false failures). `pnpm typecheck && lint && test (18) && build` green; production `/extension-version.json` serves 0.3.1.

## Loop 27 — A failed capture was a dead end, and it recovered on one click
**Date:** 2026-08-02 · **Phase:** P1 · **Outcome:** done, not deployed — see the coordination note

**The find.** A real extension capture — a dense 繁體中文 Gemini conversation — sat in the library reading "Couldn't read this one", with no summary, no tags, and "No text found" for a screenshot that is *entirely* text. The detail view, which is where anyone reading that sentence actually goes, had **no way to act on it**. The only "Try again" in the product lived in the Inbox, which a capture leaves the moment it is filed — so a failed classification that was dragged onto a project became permanently unreadable and unfixable short of deleting it and capturing again.

Clicked the new button on that exact capture: `unprocessed → done`, **0 → 707 characters of OCR**, title "Threads AI content marketing tool copy options", seven tags including 繁體中文 reused verbatim from the library vocabulary, intent `marketing_hook`. **The original failure was transient.** Failed classifications are routinely recoverable and there was nowhere to recover them from.

Re-read logic extracted to `lib/reclassify.ts` and shared, rather than a second copy on the detail page — it carries the invariants that matter (`patch` not `put`, `userTags` never discarded, and now `whySaved` preserved when the owner already wrote one) and those cannot drift across two implementations. Prominent as a recovery banner when `status === "unprocessed"`; quiet as "Read again" otherwise, because the guess improves as projects and corrections accumulate.

**Pluralisation.** Eight call sites hardcoded the plural, so one pending capture greeted you with "1 captures need a project" on the first line of the home page. `lib/plural.ts` + `verb()` for sentences that continue past the noun. Small, but it reads as carelessness in a product whose pitch is that it is more organised than you are.

**Coordination note.** A concurrent session is mid-migration to Supabase, and for part of this loop the tree did not typecheck — `lib/store/remote.ts:103` and `components/capture.tsx:530`. Both were outside anything this loop touched and were left alone rather than fixed into a moving target; that session resolved them during the loop. Final state verified green: `pnpm typecheck && lint && test (38) && build`.

**Also observed, not acted on.** `.env.local` now carries the Supabase keys, so `backend()` resolves to remote — and `map.ts:234` nulls `thumbDataUrl` for remote rows because bytes are meant to live in Storage. Every thumbnail therefore renders as the SVG placeholder. That is expected mid-migration if the Storage upload is not wired yet, but it also means browser-side verification against IndexedDB is now misleading: the local store is stale relative to what the UI reads. Worth a note in the migration's own loop.

**Brand tension to resolve, not for this loop.** The mark now appears as the sidebar wordmark and beside every project row. `drafts/brand/GUIDELINES.html` is explicit that it "can never be used as a watermark, a sidebar logo, or empty-state decoration" — its entire job is provenance, *the mark means Capso decided*, and it stops meaning that once it also decorates. Raised for whoever built it rather than reverted.

**Deploy blocker found and fixed on the way out.** `.vercelignore` carried a bare `supabase` pattern, meant for the root migrations directory. Unanchored patterns match a path segment at *any* depth, so it also excluded `apps/web/lib/supabase/` — the build failed with `Module not found: Can't resolve '@/lib/supabase/client'` for a file that exists locally and typechecks locally, which is the worst shape a build error can take. All four directory patterns are now anchored with a leading slash; `drafts`, `specs` and `prompts` were the same trap waiting to happen inside the app.

## Loop 28 — The mark stops being a logo
**Date:** 2026-08-02 · **Phase:** P1 · **Outcome:** done

Raised at the end of loop 27 as a decision rather than a fix; owner called it.

`drafts/brand/GUIDELINES.html` names three things the mark can never be — "a watermark, a sidebar logo, or empty-state decoration" — and gives the reason: its entire job is provenance, *the mark means Capso decided, its absence means you did*. A glyph that is also on screen when nothing was decided cannot carry that. It was sitting next to the "Capso" wordmark in the sidebar and again in the first-run header, which is the banned case verbatim, and it was the one place in the product where it meant nothing.

Removed from both. It stays on every icon surface (favicon, PWA, tray, extension), on the reading state in the capture overlay and thread chat, and in the rack slots.

**The rack was left alone, deliberately.** The per-project lids look like the same violation and are not: an open ring is an empty slot and a part face is a shelf with something on it, so the glyph is doing the *rack* metaphor — which the same guidelines establish — rather than claiming Capso inferred anything. It also does real work, previewing the level a slot would reach if the drag in hand landed there. Applying the provenance rule mechanically would have deleted a just-shipped interaction for a rule it does not break.

Verified: wordmark renders plain, rack slots intact and still differentiating empty from filled. `pnpm typecheck && lint && test (74) && build` green.

## Loop 29 — One tall capture owned the whole screen
**Date:** 2026-08-02 · **Phase:** P1 · **Outcome:** done

Reported from a real library: a phone screenshot of a scrolling dating-app list made the Inbox "messy and not fitted nicely". It was not a styling problem. `Thumb` rendered `h-auto w-full`, so the capture set its own height everywhere — and that capture is roughly **1:5**. In a 112px-wide Inbox row that is a 560px-tall row: one capture fills the viewport, and the keyboard triage the screen exists for becomes scrolling. The same capture ran about five column-widths tall in the gallery and required a long scroll on the detail view.

Three different fixes, because the three surfaces want different things:

- **Rows and strips get a fixed box.** `Thumb` gained `box`, rendering into an aspect-ratio container with `object-cover object-top`. Applied to Inbox, Review, both memory lists, the thread filmstrip, the sources rail and the resurfacing shelf. Cropped from the top because the top of a screenshot is the part that identifies it, and uniform because a list of wildly different heights is not scannable.
- **The gallery is capped, not boxed.** It is a moodboard and mixed heights are the point — but `max-h-[30rem] object-cover object-top` stops one capture pushing everything after it off-screen.
- **The detail hero fits the window at rest.** `max-h-[78vh] object-contain`, so a tall capture is something you look at rather than scroll past. `contain`, not `cover`: this is the one place nothing may be hidden, and zoom still gives actual pixels.

**One more plural, found while verifying.** The Inbox header read "1 need a decision" — missed in loop 27 because that grep looked for the noun and this sentence elides it. Now agrees.

Verified against a synthetic 420×2100 capture pushed through the real drop path: Inbox row compact with the title legible in the crop, gallery card bounded, detail hero fully visible without scrolling, filmstrip uniform. `pnpm typecheck && lint && test (74) && build` green.

## Loop 30 — Native capture command seam
**Date:** 2026-08-08 · **Phase:** P2 / CAP-01a · **Outcome:** done; partial CAP-01 evidence

Objective: Expose one tested native command seam for region, window, and fullscreen capture that writes to deterministic Application Support paths and treats user cancellation as a silent result.

Phase/tasks: P2 native capture entry point; `27_CLEANSHOT_DAILY_DRIVER_PARITY.md` CAP-01a; partial evidence for CAP-01/CAP-02.

In-scope files: `apps/mac/src-tauri/src/capture.rs`, `apps/mac/src-tauri/src/lib.rs`, `apps/mac/src-tauri/Cargo.toml`, `apps/mac/src-tauri/Cargo.lock`, `apps/mac/src-tauri/capabilities/default.json`, `apps/mac/README.md`, `BUILD_LOG.md`.

Out of scope: global shortcuts, clipboard, overlay UI, permissions onboarding or entitlements, durable upload queue, Supabase/auth, server processing, annotation, signing, deployment, and the pre-existing loop/draft files.

Done-when: Tauri exposes region/window/fullscreen capture; each mode maps to the intended `screencapture` arguments; output lands under the app data `captures/` directory with a UUID filename; missing output with no diagnostic is returned as `cancelled`; empty or diagnostic failures remain actionable errors; automated native tests prove these boundaries.

Verification: `cargo test --manifest-path apps/mac/src-tauri/Cargo.toml`; `cargo clippy --manifest-path apps/mac/src-tauri/Cargo.toml --all-targets -- -D warnings`; `pnpm --filter mac typecheck`; `pnpm --filter mac build`; `pnpm lint`; `pnpm test`; `git diff --check`.

Implemented a Tauri `capture_screen` command backed by `/usr/sbin/screencapture`, isolated on the blocking executor. Region, window, and main-display fullscreen modes map to restricted silent PNG arguments; UUID filenames live under the Tauri Application Support data directory; success is returned only after non-empty pixels exist; Escape/no-output is a normal `cancelled` result; diagnostics and empty files remain structured failures. Added ten Rust tests covering arguments, deterministic placement, UUIDs, success, cancellation, diagnostics, empty output, storage failure, runner launch failure, and the persisted runner boundary.

Verification: Rust tests **10/10 passed**; `RUSTFLAGS='-D warnings' cargo check --all-targets` passed; Mac TypeScript check and Vite production build passed; root typecheck, lint, and web/extension tests (**78 + 4**) passed; `git diff --check` passed; the project loop validator passed its 67 checks and 7 malformed fixtures. `rustfmt` and `clippy` were unavailable in the installed toolchain, so no global component install was attempted. Native picker/manual Screen Recording QA remains unverified because it would interrupt the foreground user.

Checker: initial REJECT found missing deterministic coverage for storage-directory and runner-launch failures. Repair attempt 1 added both proofs; the independent Checker then APPROVED the complete allowlisted diff. Native implementation commit: `01c05d1`. This does not pass CAP-01 overall; shortcuts, interactive capture QA, permissions, clipboard, and overlay remain. Next loop: CAP-01b global shortcut registration, conflict reporting, and tray actions.

## Loop 31 — Global shortcuts and tray fallbacks
**Date:** 2026-08-08 · **Phase:** P2 / CAP-01b · **Outcome:** done; partial CAP-01 evidence

Objective: Register native region, window, and main-display fullscreen shortcuts independently, report conflicts without aborting Capso, and keep each capture mode available from the tray.

Phase/tasks: P2 global capture entry points; `27_CLEANSHOT_DAILY_DRIVER_PARITY.md` CAP-01b; partial CAP-01 evidence.

In-scope files: `apps/mac/src-tauri/src/shortcuts.rs`, `apps/mac/src-tauri/src/lib.rs`, `apps/mac/src-tauri/src/capture.rs`, `apps/mac/src-tauri/Cargo.toml`, `apps/mac/src-tauri/Cargo.lock`, `apps/mac/README.md`, and loop status docs after approval.

Out of scope: shortcut settings UI, clipboard, overlay, permission onboarding, queue/history, auth/upload/AI, annotation, signing, deployment, and interactive CleanShot comparison.

Done-when: ⌃⇧C/⌃⇧W/⌃⇧F register independently through the official Tauri v2 plugin; known key-down events launch the matching persisted capture once; key-up/unrelated input does nothing; one conflict cannot block other shortcuts; the unavailable key is named in the tray while all three tray capture actions remain; overlapping shortcut/tray pickers are guarded.

Verification: the failing-first run produced three expected shortcut-test failures before implementation. Final Rust suite **14/14 passed**; `RUSTFLAGS='-D warnings' cargo check --all-targets`, root typecheck/lint, web/extension tests (**78 + 4**), Mac production build, loop validator (**67 checks + 7 malformed fixtures**), and `git diff --check` passed. The installed toolchain still lacks rustfmt/Clippy, so no global component install was attempted. No shortcut or picker was invoked unattended.

Checker: APPROVED with no P0–P2 findings. It independently confirmed isolated registration, pressed-only event handling, shared shortcut/tray overlap guard, visible conflict fallback, and no global-shortcut webview capability exposure. Native implementation commit: `056801e`. CAP-01 remains IN_PROGRESS until bindings are editable/persisted and explicit any-foreground-app/conflict QA passes. Next loop: CAP-01c.

## Loop 32 — Persisted editable shortcuts with verified rollback
**Date:** 2026-08-08 · **Phase:** P2 / CAP-01c · **Outcome:** done; partial CAP-01 evidence

Objective: Make the Region, Window, and Fullscreen bindings editable from the real menu-bar popover, persist them locally, and change the live OS registrations without sacrificing the previous working set or the tray capture fallback.

The popover now has three accessible key-combination recorders instead of a placeholder shell. A recorder consumes keys only after it is armed, shows its recording state, requires at least one modifier, and submits the complete unique set through native Tauri commands. Capso loads the settings JSON from its Application Support config directory, ignores corrupt data without overwriting it, and exposes storage/conflict health so an unchanged set can be retried after the external conflict or disk problem is resolved.

Rebinding is transactional at the application boundary: Capso unregisters the registrations it actually owns, attempts the entire candidate set, and atomically renames the JSON only after every candidate is live. Registration or persistence failure removes candidate registrations and restores the desired previous set. The rollback path then queries the plugin registry rather than trusting return strings, records the exact registrations still active, derives missing desired conflicts, tracks candidate-only leftovers for later cleanup, and warns that rollback is incomplete unless the reconciled identifier sets match exactly. Tray capture actions are rebuilt independently and remain available throughout. Global dispatch pauses while the settings popover is focused, preventing a shortcut being recorded from opening a picker.

Verification: shortcut work began with the expected failing compile against the new persistence/transaction tests. Final Rust suite **23/23 passed**, including conflict rollback, persistence rollback, failed candidate cleanup, failed previous restore, corrupt JSON preservation, and runtime reconciliation. `cargo clippy --all-targets -- -D warnings`, changed-file rustfmt checks, root typecheck/lint, web/extension tests (**78 + 4**), Mac Vite build, debug Tauri `.app` bundle, loop validator (**67 checks + 7 malformed fixtures**), `git diff --check`, and the allowlist scope check passed. The 360×480 light-mode popover passed visual inspection with no clipping or overflow. Tauri still warns about the existing `.app`-suffixed bundle identifier; that remains PKG-01a rather than being mixed into this objective.

Checker: initial REJECT found that partial rollback could leave stale runtime claims, an unarmed focused recorder still consumed keys, and unhealthy unchanged settings could not retry while a failed save cleared prior conflicts. Repair attempt 1 added registry reconciliation and two partial-failure tests, armed-only input handling with `aria-pressed`, and separate retry health with native status reload. The independent Checker then APPROVED with no P0–P2 findings. Native implementation commit: `d4d2bff`.

CAP-01 remains IN_PROGRESS: physical shortcut recording, relaunch persistence, dispatch from another foreground app, a real CleanShot/other-app conflict, rollback messaging, and native picker behavior were not invoked unattended. Next loop: UX-01a menu-bar lifecycle, opt-in login item, and permission guidance while the manual CAP-01 proof remains pending.

## Loop 33 — Permission-aware menu-bar lifecycle and opt-in login item
**Date:** 2026-08-08 · **Phase:** P2 / UX-01a · **Outcome:** done; partial UX-01 evidence

Objective: Make Capso reliably available as a menu-bar app, prevent permission-required capture paths from producing blank output, and expose launch at login only after explicit opt-in through Apple's visible Login Items mechanism.

The bundled app now declares `LSUIElement=true`, retains the runtime Accessory activation policy, hides its popover on close, and keeps an explicit tray quit action. Its bundle minimum is macOS 13, matching the approved `SMAppService` contract. Launch at login remains off until the user changes the switch; the native seam reads enabled, disabled, approval-required, and unavailable states, registers/unregisters only after the explicit action, and links to Login Items when macOS requires approval. Tauri's LaunchAgent-based autostart plugin was deliberately not used because it would violate the existing permission model.

Screen Recording preflight is read-only and runs at startup/focus without prompting. Region capture remains available in degraded mode, while Window and Fullscreen are gated before `screencapture` across shortcut, tray, and direct-command paths. A tray/shortcut attempt shows and focuses the permission guidance. The visible **Grant access** action is the only path to the OS request, and a session guard prevents repeated prompts; denial becomes an explicit System Settings action. Accessibility is neither needed nor requested.

Verification: failing-first tests proved the degraded-mode and one-prompt/session policy before implementation. Final Rust suite **28/28 passed**; `cargo fmt -- --check`, `cargo clippy --all-targets --all-features -- -D warnings`, root typecheck/lint, web/extension tests (**78 + 4**), Mac production build, debug Tauri `.app`/DMG then app-only rebuild, loop validator (**67 checks + 7 malformed fixtures**), and `git diff --check` passed. Bundle inspection confirmed `LSUIElement=true`, `LSMinimumSystemVersion=13.0`, and CoreGraphics/ServiceManagement linkage. The 360×620 popover passed light/dark Playwright inspection with exact viewport/scroll dimensions, working shortcut recording, and zero console errors. Screenshots were kept outside Git.

Checker: APPROVED with no P0–P2 findings and no repair pass. Implementation commit: `b507eec`.

UX-01 remains IN_PROGRESS: permission grant/revoke, Login Item enable/disable plus relaunch, Dock/app-switcher absence, any-app capture behavior, and signed installed-bundle behavior require manual native QA. The existing `.app`-suffixed identifier/signing warning remains PKG-01a. Next loop: CAP-02a pasteboard write with pixel verification.

## Loop 34 — Persist-first native clipboard delivery
**Date:** 2026-08-08 · **Phase:** P2 / CAP-02a · **Outcome:** done; partial CAP-02 evidence

Objective: Connect every completed native capture to macOS' image pasteboard without weakening the already-proven storage, cancellation, failure, or permission semantics.

Capso now treats the saved PNG as the source of truth. A successful region, window, or fullscreen capture first lands under Application Support, is read and signature-validated off the UI thread, and is then written byte-for-byte as `NSPasteboardTypePNG` on AppKit's main thread. Cancellation never schedules or clears the pasteboard. A pasteboard failure stays a top-level successful capture with a nested actionable clipboard status, so pixels already on disk are never deleted or reported lost.

Direct Tauri commands, tray actions, and global shortcuts converge on the same command-level RAII single-flight lease. This prevents overlapping pickers and out-of-order clipboard writes regardless of entry point, while every normal and error exit releases the lease. The `capture-finished` event now has an explicit top-level `captured`, `cancelled`, or `failed` contract rather than serializing an implementation-level `Result` wrapper.

Verification: Rust tests **43/43 passed**, including exact-byte write proof, invalid/missing PNG no-mutation boundaries, failure-with-file-preserved proof, a native custom `NSPasteboard` byte round trip, delayed scheduled-write ordering, overlapping/early-error lease release, and exact JSON for all event outcomes. `cargo fmt --check`, `cargo clippy --all-targets --all-features -- -D warnings`, root typecheck/lint, web/extension tests (**78 + 4**), the Mac Vite build, debug Tauri `.app` bundle, loop validator (**67 checks + 7 malformed fixtures**), and `git diff --check` all passed. Bundle inspection confirmed AppKit, CoreGraphics, Foundation, ServiceManagement, and WebKit linkage.

Checker: initial REJECT found a late-write race after the 500ms timeout, direct IPC bypass of the outer single-flight guard, an unproven event envelope, and stale client documentation. Repair attempt 1 removed the early timeout return, moved the lease into the shared command path, introduced a tagged event payload with four exact contract tests, and updated the Mac README. The independent Checker then APPROVED with no P0–P2 findings. Implementation commit: `3496c82`.

CAP-02 remains IN_PROGRESS. Native general-pasteboard copy/paste and perceived latency require manual QA; the Quick Access-style native overlay and 20-capture <1s proof do not exist yet. The debug bundle still carries the existing `.app`-suffixed identifier warning and only an ad-hoc linker signature; PKG-01a/01b remain required before distribution. No app was launched, no capture was invoked, and the user's clipboard and installed CleanShot X were untouched. Next loop: OVL-01a non-activating capture overlay.

## Loop 35 — Non-activating native capture overlay
**Date:** 2026-08-08 · **Phase:** P2 / OVL-01a · **Outcome:** done; partial OVL-01 and CAP-02 evidence

Objective: Connect every successful native capture to a Quick Access-style macOS thumbnail on the correct display without activating Capso, blocking the foreground app, flashing stale pixels, or weakening persist-first capture semantics.

Capso now bundles a second 252×194 webview dedicated to the latest capture. It begins hidden, undecorated, nonfocusable, always on top, visible across workspaces, absent from task surfaces, and click-through for this display-only slice. Region and window captures target the display containing the cursor when the picker completes; main-display fullscreen follows the existing `screencapture -m` contract. Placement uses the target monitor's physical work area and scale factor, including negative display origins. The asset protocol is restricted to `$APPDATA/captures/**`, and the overlay's separate capability grants only event access.

Direct commands, tray actions, and global shortcuts still converge on the same capture command. Only after the PNG is durable and clipboard delivery finishes does Rust hide and position the overlay, commit the exact capture path, and emit it. React installs the live listener before retrieving current state, loads the scoped local asset, and asks native code to show the window only after that exact PNG decodes. Cancellation and capture failures never prepare an overlay. Decode, event-delivery, or native-show failure preserves the PNG, clears only the matching preview, keeps it hidden, and reports a recoverable post-capture status.

The final state machine serializes prepare/hide/position/replace, exact-current show, and exact-current failure clear/hide under one transition lock. Deterministic fake-window tests prove both orders of old-ready versus new-prepare and stale-old-failure versus new-ready, preventing a stale callback from revealing or hiding a newer preview.

Verification began with three expected failing overlay tests before implementation. Final Rust suite **52/52 passed**, including negative-origin/scaled work-area placement, main-versus-cursor display routing, stale-path rejection, exact failed-delivery rollback, both visibility interleavings, forced native-show failure, bundle configuration, scoped assets, and event envelopes. `cargo fmt --check`, `cargo clippy --all-targets --all-features -- -D warnings`, root typecheck/lint, web/extension tests (**78 + 4**), all production builds, a fresh debug Tauri `.app` bundle, loop validator (**67 checks + 7 malformed fixtures**), and `git diff --check` passed. The 252×194 light/dark preview passed visual inspection with viewport and scroll dimensions equal and zero console errors. Screenshots stayed outside Git.

Checker: the initial review rejected decode failure revealing its fallback, fullscreen placement following the cursor instead of the main display, and failed event delivery leaving retrievable state. Repair attempt 1 fixed all three. The second review found non-atomic path validation versus native show/hide and missing reporting for native-show failure. Repair attempt 2 introduced the serialized transition seam, deterministic interleaving tests, and exact clear/hide/report behavior. The independent Checker then **APPROVED** with no remaining P0–P2 findings. Implementation commit: `91e6643`.

OVL-01 and CAP-02 remain IN_PROGRESS. Copy, Save, Annotate, drag-out, Close, auto-dismiss, and recent restore belong to OVL-01b. Native focus preservation, real mixed-scale multi-display placement, perceived latency, and general-pasteboard behavior still require manual QA. The existing `.app`-suffixed identifier warning remains PKG-01a. No app or CleanShot capture mode was launched, and no clipboard or CleanShot setting was changed. Next loop: OVL-01b interactive Quick Access actions.
