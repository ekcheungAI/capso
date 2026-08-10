# Capso CleanShot Replacement Loop State

> Persistent cross-session memory for `capso-cleanshot-replacement`.
> Read before every run; update after every run, including no-op and failure.

## Current control state

| Field | Value |
|---|---|
| Status | READY |
| Active lease | none |
| Branch | `codex/capso-cleanshot-replacement` |
| Baseline commit | `e8dd7e22adaf93ee1f023dcc0d1c58b4c038360d` |
| Current phase | Native capture plus browser-independent processing |
| Next objective | No independent queue-wake code remains: AI-01a4 website identity/library migration plus hosted redirect and AI-01b2 integration require owner approval; CAP-02b/offline QA and PKG-01 remain manual or owner gates |
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
- `supabase/.temp/`

Build outputs under ignored `target/`, `dist/`, and `.next/` are disposable caches, not
candidate source files.

## Active loops

| Loop | Schedule | Last run | Last result | Next gate |
|---|---|---|---|---|
| capso-cleanshot-replacement | hourly | 2026-08-10 09:14 HKT | DUR-01b3 APPROVED after 1 repair | Owner-gated website identity/hosted apply; then physical offline drill |

## Gate scoreboard

Status vocabulary: `NOT_STARTED`, `IN_PROGRESS`, `PASS`, `FAIL`, `BLOCKED`.

| Gate | Status | Current evidence | Next proof |
|---|---|---|---|
| UX-01 menu-bar availability | IN_PROGRESS | `b507eec` adds `LSUIElement`, Accessory lifecycle, default-off `SMAppService`, Screen Recording preflight/guidance, and a verified 360×620 popover | Native launch/quit/focus, permission, Login Item, relaunch, and Dock/app-switcher QA |
| CAP-01 native capture modes | IN_PROGRESS | `01c05d1` command seam + `056801e` defaults/tray fallbacks + `d4d2bff` persisted editable bindings with reconciled rollback; 23 Rust tests | Manual physical recording, relaunch, from-any-app, real conflict, rollback-message, and picker QA |
| CAP-02 clipboard + <1s overlay | IN_PROGRESS | `3496c82` persists first and writes exact PNG bytes through AppKit; `91e6643` prepares the native overlay only after persistence/clipboard delivery; `8923e90` adds generation-ordered re-copy; `ec43534` durably records the latest 20 successful process-completion-to-native-show samples and gates strict 20/20 `<1s` reporting; 140 Rust tests cover identity, ordering, exclusions, privacy, restart, and exact percentiles | Native general-pasteboard copy/paste QA plus the physical 20-capture perceived-latency run |
| OVL-01 overlay experience | IN_PROGRESS | `91e6643` adds the hidden-until-decode 252×194 display-correct overlay; `8923e90` adds exact-current Copy, atomic Save As, Close, and one-shot eight-second hover/action-paused dismissal; `8bd0888` restores recent durable PNGs; `db0ab1e` adds exact copy-only native drag-out; `42fcfbf` connects Annotate; `ec43534` surfaces latest-20 overlay speed evidence in the tray | Native focus, mixed-scale multi-display, interaction, relaunch-restore, drag/drop, annotation, and physical latency QA |
| ANN-01 four-tool annotation | IN_PROGRESS | `42fcfbf` adds the native arrow/box/text/irreversible-pixelate editor and durable flatten path; `4651859` proves one cross-language golden redaction fixture byte-for-byte through production pixelation, editor input validation, canonical/original save, clipboard, queue crash recovery, and drain consumption; 129 Rust + 98 workspace tests pass | Physical four-tool editor/save/copy/relaunch QA plus a downloaded remote-object pixel comparison |
| DUR-01 durable queue | IN_PROGRESS | `a5c5e80` proves synced pixels and restart FIFO; `b3b9641` proves the coordinator; `c3278ba` adds the ingest contract; Loop 48 composes Keychain with real Storage/RPC startup/capture wakes; Loop 50 connects session creation without capture-transition blocking; Loop 51 adds persisted-deadline wake/rearm plus event-driven ≤5s known-offline reconnect monitoring without consuming offline attempts | Hosted proof, then the physical three-capture offline/restart/reconnect drill |
| HIS-01 reliable history | IN_PROGRESS | `8bd0888` provides exact-ID local restore without touching the pasteboard; `e0b1020` orders by durable queue capture time, attaches bounded 48×32 native thumbnails, and adds an explicit verified production-library route while retaining full-decode/path checks | Native relaunch/menu thumbnail/click/focus proof plus queued end-to-end cloud persistence |
| AI-01 browser-independent processing | BLOCKED | `c3278ba` proves the PKCE/ingest contract; Loop 47 adds the local worker/migration; Loop 48 wires refresh, Keychain, real upload, and startup/capture drain; Loop 50 locally connects email OTP, strict HTTPS/deep-link PKCE exchange, Keychain status, and guarded sign-out. No hosted handoff deployment/allowlist, shared website identity, production apply/deploy, Vault/Cron schedule, or live database proof exists | Owner identity/library decision and production-change approval; deploy/allowlist handoff; apply/deploy/Cron; no-browser E2E proof |
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
| 7 | ✅ OVL-01b — Copy, Save, Annotate, drag-out, Close, auto-dismiss and restore actions (`8923e90`, `8bd0888`, `db0ab1e`, `42fcfbf`) | OVL-01a | interaction QA |
| 8 | CAP-02b — 20-capture overlay latency proof <!-- partial: `ec43534` records and reports the latest 20 successful fresh process-completion-to-native-show samples; the physical foreground run remains --> | OVL-01a | foreground test window |
| 9 | ✅ DUR-01a — synced capture durability plus atomic restart-safe local queue state machine (`a5c5e80`) | CAP-01a | none |
| 10 | DUR-01b — idempotent single-flight drain coordinator with exact acknowledgements, no-attempt holds, and error-safe wake handoff (`b3b9641`); Loop 48 adds real transport plus startup/capture wakes, Loop 50 adds locally created sessions without capture-transition blocking, and Loop 51 adds timed/reconnect wakes; hosted proof and the three-capture drill remain | DUR-01a, AI-01a for authenticated transport | network toggle QA only for the final drill |
| 11 | AI-01a — Mac identity/auth handoff and authenticated ingest contract <!-- partial: `c3278ba` plus Loops 48/50 connect email OTP, strict HTTPS/deep-link PKCE, Keychain exchange/refresh/status, guarded sign-out, real upload, and startup/capture drain locally; hosted route deployment/redirect allowlisting, same website identity, live proof, and anonymous-library linking remain --> | DUR-01a | production identity/linking decision required |
| 12 | AI-01b — server-side worker so processing continues with every browser closed <!-- partial: Loop 47 adds the locally verified one-job worker core and unapplied atomic jobs migration; AI-01b2 must add job production, Vault/Cron, production apply/deploy, and live integration proof --> | AI-01a | production/migration approval before apply |
| 13 | AI-01c — no-browser end-to-end proof | AI-01b | foreground capture QA |
| 14 | ✅ ANN-01a — native four-tool editor, protected first original, atomic flatten, queue reservation/recovery, clipboard re-copy, and overlay refresh (`42fcfbf`) | OVL-01b, DUR-01a | annotation QA |
| 15 | ✅ ANN-01b — exact irreversible redaction and flattened pixels through save, clipboard, queue restart, and drain (`4651859`) | ANN-01a | physical/cloud-object QA remains under ANN-01 |
| 16 | ✅ HIS-01a — exact local restore plus queue-timestamped five-item thumbnail menu and full-library deep link (`8bd0888`, `e0b1020`) | DUR-01a | native history QA |
| 17 | LRN-01a — scripted three-corrections-to-fourth-capture evaluation | AI-01b | model calls approved under existing config |
| 18 | RET-01a — pgvector + keyword retrieval implementation | AI-01b | embedding-provider decision if unresolved |
| 19 | RET-01b — exact OCR and vague-memory golden query evaluation | RET-01a | real dogfood corpus |
| 20 | PKG-01a — correct bundle identity and entitlement manifest | UX-01a | permanent reverse-DNS identity/entitlement approval required |
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
| 2026-08-08 06:25 | capso-cleanshot-replacement | DUR-01a synced durable local queue state machine | APPROVED after 1 repair | `a5c5e80` | 98/98 Rust and 10/10 Mac tests prove file/directory sync boundaries, atomic JSON commit, restart FIFO/orphan recovery, exact interrupted 5s/30s/2m retry, four-attempt poison isolation, idempotency, corrupt/inconsistent-store preservation, and zero capture deletion; strict Clippy, full root verification, fresh debug `.app`, loop validator, and diff/scope checks pass. Checker repair added end-to-end fsync, orphan reconciliation, and restart backoff. No network drain/auth/AI exists; next: DUR-01b1. |
| 2026-08-08 06:45 | capso-cleanshot-replacement | DUR-01b1 fake-transport drain coordinator | APPROVED after 1 repair | `b3b9641` | 104/104 Rust tests prove offline/auth holds consume no attempt, reconnect FIFO, exact-ID completion, retry/mismatch healthy-work isolation, restart idempotency, single-flight overlap, and error-safe coalesced wake handoff; strict Clippy, full root verification, fresh debug `.app`, loop validator, and diff/scope checks pass. No production transport/auth/connectivity monitor or real offline drill exists; next: AI-01a. |
| 2026-08-08 07:23 | capso-cleanshot-replacement | AI-01a1 native PKCE and authenticated-ingest contract | APPROVED after 2 repairs | `c3278ba` | 113/113 Rust and 95/95 workspace tests prove exact raw callback shape, opaque codes, S256/state expiry/replay/redaction, strict shared/Rust ingest boundaries, no caller ownership, exact acknowledgement, and safe error dispositions; strict Clippy, full build/lint/typecheck, fresh arm64 `.app`, loop validator, and diff/scope checks pass. No production session, upload, or worker exists; identity/linking is an owner gate. Next independent code objective: ANN-01a. |
| 2026-08-08 08:21 | capso-cleanshot-replacement | ANN-01a native four-tool editor and flattened queue pixels | FAILED after 2 repairs | — | The uncommitted WIP reached 127/127 Rust and 97/97 workspace tests, strict Clippy, full build/lint/typecheck, loop validation, light/dark/min-window QA, and an arm64 debug `.app`. Checker passes repaired close/retry deadlocks, timeout, capture/annotation mutual exclusion, atomic overlay publication, and original fsync recovery, but final review found history changes clipboard ownership before its overlay publication wins. If Annotate wins, Save/Copy become stale. No rejected source was committed. Next run: make history clipboard activation and overlay publication one transaction with rollback/deferred commit, add the losing-history interleaving test, and resubmit ANN-01a. |
| 2026-08-08 08:33 | capso-cleanshot-replacement | ANN-01a transactional history repair and native four-tool editor resubmission | APPROVED | `42fcfbf` | Clipboard identity now commits only after history overlay publication wins; a deterministic history-versus-real-AnnotationRuntime interleaving proves losing history leaves the fresh capture copyable. 128/128 Rust and 97/97 workspace tests, strict Clippy, format, lint, typecheck, full builds, fresh debug `.app`, loop validation, and diff checks pass. Checker approved submission 1 with no P0–P2 findings. Native pixel/physical QA remains; next: ANN-01b. |
| 2026-08-08 08:48 | capso-cleanshot-replacement | ANN-01b exact irreversible redaction and flattened-pixel chain | APPROVED | `4651859` | A shared 4×4 golden fixture proves production pixelation collapses 16 source values to one exact RGBA value, and the native test carries those exact flattened bytes through editor data-URL validation, canonical/original persistence, clipboard, queue crash-window recovery, restart reconciliation, and drain consumption. 129/129 Rust and 98/98 workspace tests, strict Clippy, format, typecheck, lint, builds, fresh arm64 `.app`, loop validation, and diff checks pass. Checker approved submission 1 with no blocking findings. Remote-object and physical native QA remain; next: HIS-01a. |
| 2026-08-08 10:28 | capso-cleanshot-replacement | HIS-01a queue-timestamped thumbnail history and Open Library | APPROVED | `e0b1020` | The five-item native menu now uses stable queue capture timestamps, fully decoded fixed 48×32 aspect-preserving thumbnails, exact UUID restore, and an explicit `https://capso-cyan.vercel.app/library` action. 133/133 Rust and 98/98 workspace tests, strict Clippy, format, typecheck, lint, builds, fresh arm64 `.app`, live route 200, loop validation, and diff checks pass. Checker approved submission 1 with no P0–P2 findings. Native menu/relaunch/focus QA and cloud persistence remain; next: PKG-01a owner decision. |
| 2026-08-08 10:59 | capso-cleanshot-replacement | CAP-02b1 durable overlay speed evidence | APPROVED | `ec43534` | The latest 20 successful fresh process-completion-to-native-show durations survive restart without capture identifiers, paths, timestamps, or pixels; stale/history/annotation/decode/show failures are excluded, and the tray reports progress plus exact p50/p90/max with strict 20/20 `<1s` gating. 140/140 Rust and 98/98 workspace tests, strict Clippy, format, typecheck, lint, builds, fresh arm64 `.app`, loop validation, and diff checks pass. Checker approved submission 1 with no P0–P2 findings. Physical perceived latency and general-pasteboard QA remain. |
| 2026-08-08 22:56 | capso-cleanshot-replacement | AI-01b1 browser-independent one-job worker core | APPROVED after 1 repair | this commit | A service-role-only Edge worker claims one owner-serial job, loads the exact bounded PNG plus owner-scoped projects/corrections, calls MiniMax with one schema repair and a 48 KB prompt ceiling, and atomically settles with bounded retry/lease recovery. Checker repair 1 closed a cross-owner correction join and bounded response/prompt memory. 18/18 Deno and 98/98 workspace tests, Deno check/info (3.87 MB), full typecheck/lint/build, loop validation, and diff checks pass. Migration execution, model/live DB integration, deploy, job producer, Vault/Cron, Mac auth/upload, and embeddings remain. |
| 2026-08-09 17:49 | capso-cleanshot-replacement | AI-01a2/DUR-01b2 authenticated native runtime wiring | APPROVED after 1 repair | this commit | Existing matching Keychain sessions refresh and drive the real Storage/RPC drain off the UI thread at startup and after durable capture enqueue. Missing config/session and Quick Access/annotation holds consume zero attempts; Checker repair 1 prevents fast pre-edit upload and proves the flattened bytes drain after completion. 160/160 Rust, 98/98 workspace, and 19/19 worker tests; strict Clippy, format, typecheck, lint, builds, fake-secret rejection, loop validation, and a fresh 46 MB arm64 debug `.app` pass. Same Checker approved with no remaining P0–P2 findings. No login-created session, hosted apply/proof, retry timer/connectivity monitor, or real offline drill exists. |
| 2026-08-10 01:57 | capso-cleanshot-replacement | AI-01a3 native email sign-in and non-blocking auth transitions | APPROVED | this commit | Native email OTP opens an exact HTTPS handoff and accepts only a token-free `capso://auth/callback` PKCE result before Keychain persistence. OTP/PKCE/status/session-read/refresh and drain network work never holds the capture-transition mutex; RAII activity guards block sign-out during auth/drain, and sign-out intentionally retains the boundary for atomic Keychain deletion after queue checks. 170/170 Rust, 101/101 workspace, 19/19 worker tests, strict Clippy/format/typecheck/lint/builds, Deno checks, 67+7 loop validation, and fresh 47 MB `.app` plus 13 MB DMG pass. The same Checker approved the complete product submission with no P0–P2 findings. Hosted redirect deployment/allowlisting, shared website identity, live data proof, signing, and offline QA remain. |
| 2026-08-10 09:14 | capso-cleanshot-replacement | DUR-01b3 persisted retry deadline and reconnect wakes | APPROVED after 1 repair | this commit | The native drain now wakes at persisted retry deadlines and within five seconds of a known offline route returning, probes route state before Auth/transport, and consumes zero attempts while known offline. Checker repair 1 added bounded same-deadline rearming after pre-claim Auth failure, preserved offline state across probe errors, and replaced idle polling with coalesced event waits. 179/179 Rust and 101/101 workspace tests, strict Clippy/format/typecheck/lint/builds, 19/19 worker tests/check, 67+7 loop validation, and a fresh 47 MB `.app` plus 13 MB DMG pass. A newer Deno formatter would reflow one untouched out-of-scope worker migration test; source diff remains absent. Hosted proof and the physical offline drill remain. |

## Discovered technical debt

| Priority | Area | Debt | Disposition |
|---|---|---|---|
| P0 | Processing | Native startup/capture can now drive the real upload/job-registration transport behind an existing session, but hosted schema/function/Cron integration is unproven and inactive. | AI-01b2 production approval/apply plus live no-browser proof. |
| P0 | Identity | Native email/PKCE can create a Keychain session locally, but the handoff is not deployed/allowlisted and the anonymous/local website library cannot be silently transferred to that account. | AI-01a4 hosted redirect plus owner identity/library linking decision. |
| P1 | Distribution | Bundle id ends in `.app`; build is ad-hoc signed and fails Gatekeeper. | PKG-01a. |
| P1 | Permissions | Preflight/guidance and capture gating are implemented, but Screen Recording grant and multi-display behavior have no native E2E evidence. | CAP-01/UX-01 manual QA. |
| P1 | Retrieval | Current search is lexical; embedding column is not used by the client path. | RET-01a. |

## Blocked owner decisions

- Approve the permanent reverse-DNS bundle identifier and entitlement manifest before
  PKG-01a changes macOS identity; `com.capso.app` is temporary and unsuitable.
- Developer ID signing/notarization credentials are required only after PKG-01a.
  Never read, export, or alter signing credentials without explicit owner approval.
- Decide whether native sign-in adopts/migrates the current anonymous browser library or
  starts a fresh authenticated library before AI-01a production wiring.
- Changing production auth, applying database migrations, spending money, distributing a
  build, or changing CleanShot settings remains a STOP-and-ask action.
