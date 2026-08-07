# Capso CleanShot Replacement Loop State

> Persistent cross-session memory for `capso-cleanshot-replacement`.
> Read before every run; update after every run, including no-op and failure.

## Current control state

| Field | Value |
|---|---|
| Status | READY |
| Active lease | none |
| Branch | `codex/capso-cleanshot-replacement` |
| Baseline commit | `d3fd58f2a25efbf3d4c1596ed9ae8fb1127c2aba` |
| Current phase | Native capture vertical slice |
| Next objective | DUR-01a: durable local queue state machine, written test-first; CAP-02b remains a foreground manual proof |
| Exit authority | `27_CLEANSHOT_DAILY_DRIVER_PARITY.md` five-day dogfood gate |

## Protected pre-existing work

These paths were already untracked when the loop was created. Every run must preserve
them and must never stage, delete, rename, or rewrite them unless Elvin separately asks:

- `.playwright-cli/`
- `design-qa.md`
- `drafts/2026-08-03_capso-image2-preview/`
- `drafts/2026-08-03_capso-interactive-preview/`
- `package-lock.json`
- `qa/`

Build outputs under ignored `target/`, `dist/`, and `.next/` are disposable caches, not
candidate source files.

## Active loops

| Loop | Schedule | Last run | Last result | Next gate |
|---|---|---|---|---|
| capso-cleanshot-replacement | hourly | 2026-08-08 05:48 HKT | OVL-01b2b approved after 2 repairs and committed | DUR-01a |

## Gate scoreboard

Status vocabulary: `NOT_STARTED`, `IN_PROGRESS`, `PASS`, `FAIL`, `BLOCKED`.

| Gate | Status | Current evidence | Next proof |
|---|---|---|---|
| UX-01 menu-bar availability | IN_PROGRESS | `b507eec` adds `LSUIElement`, Accessory lifecycle, default-off `SMAppService`, Screen Recording preflight/guidance, and a verified 360×620 popover | Native launch/quit/focus, permission, Login Item, relaunch, and Dock/app-switcher QA |
| CAP-01 native capture modes | IN_PROGRESS | `01c05d1` command seam + `056801e` defaults/tray fallbacks + `d4d2bff` persisted editable bindings with reconciled rollback; 23 Rust tests | Manual physical recording, relaunch, from-any-app, real conflict, rollback-message, and picker QA |
| CAP-02 clipboard + <1s overlay | IN_PROGRESS | `3496c82` persists first and writes exact PNG bytes through AppKit; `91e6643` prepares the native overlay only after persistence/clipboard delivery; `8923e90` adds generation-ordered re-copy so stale manual writes cannot replace a newer capture; 59 Rust tests cover byte identity, delayed writes, overlay ordering, and failure isolation | Native general-pasteboard copy/paste QA plus the 20-capture latency proof |
| OVL-01 overlay experience | IN_PROGRESS | `91e6643` adds the hidden-until-decode 252×194 display-correct overlay; `8923e90` adds exact-current Copy, atomic Save As, Close, and one-shot eight-second hover/action-paused dismissal; `8bd0888` restores recent durable PNGs; `db0ab1e` adds exact copy-only native drag-out with bounded preview and protected-original semantics | Annotate, plus native focus, mixed-scale multi-display, interaction, relaunch-restore, drag/drop, and latency QA |
| ANN-01 four-tool annotation | IN_PROGRESS | Web editor and 15 annotation tests pass | Wire editor to native capture and pixel proof |
| DUR-01 durable queue | NOT_STARTED | Browser/extension durability exists; no Mac queue | Restart/offline/idempotency tests |
| HIS-01 reliable history | IN_PROGRESS | `8bd0888` scans the five newest valid durable UUID PNGs at launch and exposes exact-ID native Recent Captures restore without touching the pasteboard | Native relaunch/menu interaction proof, thumbnails, full-library deep links, and queued end-to-end persistence |
| AI-01 browser-independent processing | BLOCKED | Classification caller is browser-only | Authenticated native ingest + server worker |
| LRN-01 correction learning | IN_PROGRESS | Last 20 project corrections reach prompt | Scripted 3→4 eval with native ingest |
| RET-01 retrieval | IN_PROGRESS | Lexical retrieval passes; pgvector path absent | Hybrid search golden evaluation |
| PKG-01 signed installer | BLOCKED | Local `.app`/`.dmg` build; ad-hoc signature fails Gatekeeper | Fix identifier; Developer ID/notarization owner gate |
| DOG-01 five-day dogfood | NOT_STARTED | Replacement gates incomplete | Start only after all prior gates PASS |

## Ordered task queue

The hourly loop always takes the first unblocked item and shrinks it to one verifiable
outcome that fits the run budget.

| Order | Objective | Depends on | Human action |
|---|---|---|---|
| 1 | ✅ CAP-01a — native command seam for region/window/fullscreen plus cancel/error tests (`01c05d1`) | schema/buckets live | none |
| 2 | ✅ CAP-01b — default global shortcuts, conflict reporting, and tray actions (`056801e`) | CAP-01a | manual shortcut QA |
| 3 | ✅ CAP-01c — persisted editable bindings and safe shortcut re-registration (`d4d2bff`) | CAP-01b | manual shortcut/conflict QA |
| 4 | ✅ UX-01a — menu-bar lifecycle, opt-in login item, permission detection and guidance (`b507eec`) | CAP-01a | permission/login-item/lifecycle QA |
| 5 | ✅ CAP-02a — pasteboard write with pixel verification (`3496c82`) | CAP-01a | clipboard QA |
| 6 | ✅ OVL-01a — non-activating overlay on the capture display (`91e6643`) | CAP-02a | focus + multi-display QA |
| 7 | OVL-01b — Copy, Save, Annotate, drag-out, Close, auto-dismiss and restore actions <!-- partial: `8923e90` completes generation-safe Copy, atomic Save As, Close, and hover/action-paused auto-dismiss; `8bd0888` completes durable recent restore; `db0ab1e` completes native copy-only drag-out; Annotate remains and depends on DUR-01a --> | OVL-01a | interaction QA |
| 8 | CAP-02b — 20-capture overlay latency proof | OVL-01a | foreground test window |
| 9 | DUR-01a — durable local queue state machine, written test-first | CAP-01a | none |
| 10 | DUR-01b — three-capture offline/restart/reconnect drill with no duplicates | DUR-01a | network toggle QA |
| 11 | AI-01a — Mac identity/auth handoff and authenticated ingest contract | DUR-01a | auth decision if required |
| 12 | AI-01b — server-side worker so processing continues with every browser closed | AI-01a | production/migration approval before apply |
| 13 | AI-01c — no-browser end-to-end proof | AI-01b | foreground capture QA |
| 14 | ANN-01a — reuse the four-tool editor from the overlay and flatten before final upload | OVL-01b, DUR-01a | annotation QA |
| 15 | ANN-01b — irreversible blur and flattened-pixel proof | ANN-01a | none |
| 16 | HIS-01a — recent captures menu and full library deep links <!-- partial: `8bd0888` completes the five-item text menu and exact-ID local restore; thumbnails, full-library deep links, and native QA remain --> | DUR-01a | history QA |
| 17 | LRN-01a — scripted three-corrections-to-fourth-capture evaluation | AI-01b | model calls approved under existing config |
| 18 | RET-01a — pgvector + keyword retrieval implementation | AI-01b | embedding-provider decision if unresolved |
| 19 | RET-01b — exact OCR and vague-memory golden query evaluation | RET-01a | real dogfood corpus |
| 20 | PKG-01a — correct bundle identity and entitlement manifest | UX-01a | none |
| 21 | PKG-01b — Developer ID signing and notarization | PKG-01a | explicit credentials/distribution approval |
| 22 | PKG-01c — fresh-user install and onboarding proof | PKG-01b | fresh macOS user QA |
| 23 | DOG-01 — five-day, 50-capture replacement period | every scoreboard gate PASS | Elvin daily use |

Manual objectives are allowed to remain BLOCKED while independent code objectives whose
dependencies pass continue. DOG-01 is never eligible until every preceding scoreboard gate
is PASS; a skipped or unverified gate is not PASS.

## Run history

| Timestamp (HKT) | Loop | Objective | Result | Commit | Evidence / next action |
|---|---|---|---|---|---|
| 2026-08-08 01:34 | capso-cleanshot-replacement | CAP-01a native command seam | APPROVED after 1 repair | `01c05d1` | 10/10 Rust tests; warnings-as-errors, typecheck, lint, 78+4 tests, Mac build, loop validator, and diff check pass. Next: CAP-01b. |
| 2026-08-08 01:49 | capso-cleanshot-replacement | CAP-01b global shortcuts and tray fallbacks | APPROVED | `056801e` | 14/14 Rust tests; warnings-as-errors, typecheck, lint, 78+4 tests, Mac build, loop validator, and diff check pass. Next: CAP-01c. |
| 2026-08-08 02:22 | capso-cleanshot-replacement | CAP-01c persisted editable shortcuts and safe re-registration | APPROVED after 1 repair | `d4d2bff` | 23/23 Rust tests; Clippy warnings-as-errors, root typecheck/lint, 78+4 tests, Mac and Tauri app builds, 360×480 visual QA, loop validator, and diff/scope checks pass. Manual native QA remains; next: UX-01a. |
| 2026-08-08 02:45 | capso-cleanshot-replacement | UX-01a menu lifecycle, permissions, and opt-in login item | APPROVED | `b507eec` | 28/28 Rust tests; Clippy warnings-as-errors, root typecheck/lint, 78+4 tests, Mac/Tauri app builds, bundle metadata/link inspection, 360×620 light/dark visual QA, zero overflow/console errors, loop validator, and diff/scope checks pass. Native permission/login/relaunch/Dock QA remains; next: CAP-02a. |
| 2026-08-08 03:07 | capso-cleanshot-replacement | CAP-02a persisted native PNG to AppKit pasteboard | APPROVED after 1 repair | `3496c82` | 43/43 Rust tests; delayed-write ordering, exact-byte custom pasteboard, single-flight, and event-contract proofs; Clippy warnings-as-errors, root typecheck/lint, 78+4 tests, debug `.app` bundle, loop validator, and diff/scope checks pass. Native general-pasteboard QA remains; next: OVL-01a. |
| 2026-08-08 03:49 | capso-cleanshot-replacement | OVL-01a non-activating native capture overlay | APPROVED after 2 repairs | `91e6643` | 52/52 Rust tests include negative-origin/scaled placement, main-vs-cursor display routing, hidden-until-decode, serialized stale-callback interleavings, delivery/decode/show failure isolation, and exact event contracts; Clippy warnings-as-errors, root typecheck/lint, 78+4 tests, 252×194 light/dark visual QA, debug `.app`, loop validator, and diff/scope checks pass. Native focus/mixed-scale/latency QA remains; next: OVL-01b. |
| 2026-08-08 04:29 | capso-cleanshot-replacement | OVL-01b1 interactive Copy, Save As, Close, and auto-dismiss | APPROVED after 1 repair | `8923e90` | 59/59 Rust and 6/6 Mac tests prove exact-current actions, ordered clipboard mutation, alias-safe atomic export, stale UI response rejection, and one-shot pause/reset timing; Clippy warnings-as-errors, root typecheck/lint/build, 78+4 tests, 252×194 dark interaction QA, fresh debug `.app`, loop validator, and diff/scope checks pass. Native interaction/focus QA remains; next: OVL-01b2. |
| 2026-08-08 05:12 | capso-cleanshot-replacement | OVL-01b2a durable Recent Captures restore | APPROVED after 2 repairs | `8bd0888` | 74/74 Rust and 6/6 Mac tests prove full-decode history filtering, exact UUID revalidation, repeated-path presentation safety, and atomic history/fresh-capture ordering; strict Clippy, root typecheck/lint/build, 78+4 tests, 252×194 history preview QA, fresh debug `.app`, loop validator, and diff/scope checks pass. Native relaunch/menu/focus/pasteboard QA remains; next: OVL-01b2b. |
| 2026-08-08 05:48 | capso-cleanshot-replacement | OVL-01b2b native Quick Access drag-out | APPROVED after 2 repairs | `db0ab1e` | 84/84 Rust and 10/10 Mac tests prove exact copy proxy bytes, bounded preview, conservative cleanup, single-flight path/presentation ordering, local-calendar naming, and release/repress rejection; strict Clippy, full root verification, dark overlay browser QA, fresh debug `.app`, loop validator, and diff/scope checks pass. Real Finder/AppKit drop, preview, cancel/retention cleanup, source hash, focus, and timer behavior remain manual; next independent objective: DUR-01a. |

## Discovered technical debt

| Priority | Area | Debt | Disposition |
|---|---|---|---|
| P0 | Processing | Native captures cannot classify without an open browser tab. | AI-01b before dogfood. |
| P0 | Identity | Browser anonymous auth cannot be transferred safely to the Mac app. | AI-01a; owner decision if auth model changes. |
| P1 | Distribution | Bundle id ends in `.app`; build is ad-hoc signed and fails Gatekeeper. | PKG-01a. |
| P1 | Permissions | Preflight/guidance and capture gating are implemented, but Screen Recording grant and multi-display behavior have no native E2E evidence. | CAP-01/UX-01 manual QA. |
| P1 | Retrieval | Current search is lexical; embedding column is not used by the client path. | RET-01a. |

## Blocked owner decisions

- Developer ID signing/notarization credentials are required only when PKG-01a begins.
  Never read, export, or alter signing credentials without explicit owner approval.
- Changing production auth, applying database migrations, spending money, distributing a
  build, or changing CleanShot settings remains a STOP-and-ask action.
