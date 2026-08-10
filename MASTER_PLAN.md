# Capso — Master Plan

> Canonical entry point for the Capso planning pack. Every planning or build session starts here.
> Status: **Build active — native CleanShot replacement loop.** Last updated: 2026-08-10.

## 1. Product summary

**Capso** (working name — see Assumptions) is a Mac + Web screenshot-first AI memory tool. It replaces a CleanShot X subscription on the capture side, then goes where CleanShot never does: every screenshot is automatically OCR'd, summarized, classified by intent, and attached to a **project thread** the AI suggests and the user confirms in one click. Later, the user types a plain-language sentence ("the pricing page I saved in March") and Capso finds it — or discusses it inside an ongoing project conversation.

The core loop:

```
capture (hotkey) → overlay + background upload → cheap AI pass (OCR/summary/intent/project suggestion)
→ one-click confirm (or Inbox) → later: natural-language search + thread chat that cites prior screenshots
```

Not a social bookmarking app, not a notes app, not a dev-only screenshot pipe, not a flat auto-tagged gallery.

## 2. Target user

Solo marketers, founders, and product-builder hybrids who screenshot design inspiration, UX bugs, competitor moves, and marketing references daily — and lose them. **Customer zero is the owner (Elvin)**; the product is a personal tool first with SaaS-ready architecture and economics from day one. See [03_PERSONAS_AND_USE_CASES.md](03_PERSONAS_AND_USE_CASES.md).

## 3. Document map

| Area | Docs |
|---|---|
| Orientation | [README.md](README.md) (how to use this pack) |
| Product core | [01_PRODUCT_BRIEF.md](01_PRODUCT_BRIEF.md) · [02_USER_PROBLEMS_AND_JTBD.md](02_USER_PROBLEMS_AND_JTBD.md) · [03_PERSONAS_AND_USE_CASES.md](03_PERSONAS_AND_USE_CASES.md) · [04_MVP_SCOPE.md](04_MVP_SCOPE.md) ← scope authority |
| Feature specs | [05_FEATURE_SPEC_CAPTURE.md](05_FEATURE_SPEC_CAPTURE.md) · [06_FEATURE_SPEC_AI_MEMORY.md](06_FEATURE_SPEC_AI_MEMORY.md) · [07_FEATURE_SPEC_PROJECT_THREADS.md](07_FEATURE_SPEC_PROJECT_THREADS.md) · [08_FEATURE_SPEC_SEARCH_AND_RETRIEVAL.md](08_FEATURE_SPEC_SEARCH_AND_RETRIEVAL.md) |
| System | [09_AI_SYSTEM_AND_MODEL_ROUTING.md](09_AI_SYSTEM_AND_MODEL_ROUTING.md) ← cost authority · [10_DATA_MODEL.md](10_DATA_MODEL.md) ← schema authority · [11_ARCHITECTURE.md](11_ARCHITECTURE.md) · [14_BACKEND_AND_STORAGE.md](14_BACKEND_AND_STORAGE.md) |
| Platform plans | [12_MAC_APP_PLAN.md](12_MAC_APP_PLAN.md) · [13_WEB_APP_PLAN.md](13_WEB_APP_PLAN.md) · [15_DESIGN_SYSTEM_AND_UX.md](15_DESIGN_SYSTEM_AND_UX.md) |
| Business | [16_PRICING_AND_PACKAGING.md](16_PRICING_AND_PACKAGING.md) · [17_METRICS_AND_ANALYTICS.md](17_METRICS_AND_ANALYTICS.md) · [18_RISKS_AND_OPEN_QUESTIONS.md](18_RISKS_AND_OPEN_QUESTIONS.md) |
| Execution | [19_BUILD_SEQUENCE.md](19_BUILD_SEQUENCE.md) ← phase authority · [20_AGENT_LOOP_INSTRUCTIONS.md](20_AGENT_LOOP_INSTRUCTIONS.md) ← loop contract · [21_ACCEPTANCE_CRITERIA.md](21_ACCEPTANCE_CRITERIA.md) · [22_TEST_PLAN.md](22_TEST_PLAN.md) · [23_LAUNCH_CHECKLIST.md](23_LAUNCH_CHECKLIST.md) |
| Memory | [24_FEATURE_SPEC_MEMORY.md](24_FEATURE_SPEC_MEMORY.md) |
| Deep specs | [specs/user_flows.md](specs/user_flows.md) · [specs/edge_cases.md](specs/edge_cases.md) · [specs/api_contracts.md](specs/api_contracts.md) · [specs/event_schema.md](specs/event_schema.md) · [specs/permission_model.md](specs/permission_model.md) |
| Agent modes | [prompts/FABLE5_DISCOVERY_PROMPT.md](prompts/FABLE5_DISCOVERY_PROMPT.md) · [prompts/FABLE5_ARCHITECTURE_PROMPT.md](prompts/FABLE5_ARCHITECTURE_PROMPT.md) · [prompts/FABLE5_MVP_BUILD_PROMPT.md](prompts/FABLE5_MVP_BUILD_PROMPT.md) · [prompts/FABLE5_REVIEW_PROMPT.md](prompts/FABLE5_REVIEW_PROMPT.md) |

Where docs conflict, the "authority" doc for that domain wins; fix the conflict in the same session you find it.

## 4. Decisions made (log)

| # | Date | Decision |
|---|---|---|
| D1 | 2026-07-31 | v1 input = **screenshots only**. Links/PDFs/files are schema-ready (`capture_kind`) but not built. |
| D2 | 2026-07-31 | Capture bar to cancel CleanShot X: hotkey **region + window capture, clipboard copy, basic annotation** (arrow/box/text/blur). Scrolling capture and recording/GIF deferred. |
| D3 | 2026-07-31 | Post-capture default: **floating thumbnail overlay + background auto-save**, AI project/type suggestion inline (~3–5s), one-click confirm or ignore → Inbox. "Ask AI" opens thread chat. |
| D4 | 2026-07-31 | Privacy posture (MVP): **cloud for everything** on owner's Supabase; AI providers see images transiently. Sensitive-exclude toggle + app blocklist post-MVP. |
| D5 | 2026-07-31 | Build ambition: **lean — usable core loop in ~2–4 weeks** of agent build loops. Scope is cut to protect this. |
| D6 | 2026-07-31 | Monetization: **freemium subscription** documented (free: capture+OCR+limited AI; Pro ~US$9/mo). Billing **not built** in MVP. |
| D7 | 2026-07-31 | Mac shell: **Tauri 2** menu-bar app; MVP capture via macOS `screencapture -i`/`-iw`. Fallback rule: switch to Electron if Tauri friction burns >2 days. |
| D8 | 2026-07-31 | Backend: **Supabase** (Postgres + pgvector, Storage, Auth, Edge Functions, jobs + pg_cron). Web: **Next.js 15 on Vercel**. |
| D9 | 2026-07-31 | AI routing: **one Haiku-class vision call per capture** (OCR+summary+intent+project suggestion, structured JSON) + embedding, target <US$0.01/capture; **Sonnet/Fable-class only** for chat turns and weekly digests. |
| D10 | 2026-07-31 | Learning loop: confirmations/corrections stored as data, injected as **few-shot context** into classification. No fine-tuning in MVP. |
| D11 | 2026-07-31 | **Chrome extension (MV3) added as a capture path.** Captures browser tabs only — native apps (Figma desktop, Xcode, Cursor) still need the Mac app, so it complements rather than replaces it. Not yet built. |
| D12 | 2026-07-31 | **MiniMax M3 replaces the Haiku/Sonnet split.** Coding-plan key on the Anthropic-compatible endpoint; one provider for both the per-capture pass and chat. Revises D9. The `lib/ai` seam keeps swapping back to a one-file change. |
| D13 | 2026-07-31 | **Memory optimisation is a first-class surface** (new M10) — see [24_FEATURE_SPEC_MEMORY.md](24_FEATURE_SPEC_MEMORY.md). No pack doc had specified any UI for viewing or editing what the system learned. |
| D14 | 2026-07-31 | **`why_saved` is user-editable**, superseding `06_FEATURE_SPEC_AI_MEMORY.md` §5. Each edit writes a correction row. |
| D15 | 2026-08-08 | Owner approved an hourly Maker–Checker build loop whose exit is daily-driver CleanShot replacement: intentional region/window/fullscreen capture, clipboard, non-activating overlay, four-tool annotation, durable history, and post-capture background learning. Fullscreen is added to the capture path; scrolling capture, recording/GIF, pins, background composition, and passive screen observation remain out. P2 native capture primitives may proceed while the remaining P0 Mac-auth/CI/telemetry and P1 worker gaps stay explicit blockers for AI processing and dogfood, not blockers for local capture-risk spikes. |
| D16 | 2026-08-10 | The permanent email account starts a **fresh authenticated library**. Existing anonymous/local browser captures remain separate and are not silently adopted, linked, or uploaded. The same email is used on web and Mac. |

## 5. Current assumptions (unverified — challenge freely)

- **"Capso" is a working name** taken from the project folder; no trademark/domain check has been done.
- Single-user (owner) usage for the entire MVP phase; SaaS-readiness is architectural only.
- macOS `screencapture -i` picker quality is acceptable as the MVP capture UX (validated only anecdotally).
- One cheap vision call can deliver good-enough OCR (incl. Traditional Chinese) + classification in a single structured response.
- Supabase Edge Function limits are sufficient for the vision-call worker (verify timeout in P1; escalate per 11_ARCHITECTURE.md if not).
- Per-call cost figures in 09/16 use placeholder pricing marked "verify at build time."

## 6. Unresolved questions

| Q | Owner decision needed | Blocking? |
|---|---|---|
| Final product name (trademark + domain + App Store availability) | Before any external tester | Not blocking build |
| Embedding provider/model choice (2 candidates in 09) | P3 (OCR/classification phase) | Blocks P3 start |
| Digest cadence + delivery channel (weekly? email vs in-app) | Post-MVP feature | No |
| Direct distribution (dmg) vs Mac App Store | Before external testers; dmg assumed | No |
| When to enable links/PDF ingestion | Post-MVP review | No |

## 7. Recommended next action

Run `loops/capso-cleanshot-replacement-loop.md` on
`codex/capso-cleanshot-replacement`. Native Quick Access drag-out now joins the approved
Copy, Save As, Close, auto-dismiss, and durable Recent Captures restore actions. `a5c5e80`
adds synced capture pixels and an atomic restart-safe local queue, while `b3b9641` adds the
production-compiled single-flight drain coordinator with exact-ID acknowledgement and
error-safe wake handoff proofs. `c3278ba` now adds a strict native PKCE callback seam and
shared authenticated-ingest request/ack/error contract without caller-supplied ownership.
The native app now requests an email OTP, opens a strict HTTPS handoff, accepts only the
token-free `capso://auth/callback?code=...&state=...` shape, exchanges the PKCE code, and
stores the resulting same-project session in Keychain. The native startup/capture runtime
loads that matching Keychain session, refreshes it before expiry, creates the real Storage/RPC transport, and
wakes the durable drain off the UI thread. `42fcfbf` now connects a native four-tool
annotation editor, preserves the first original, atomically flattens the durable PNG, and
keeps queue/clipboard/overlay identity aligned across save and retry. `4651859` adds an
exact cross-language golden proof that irreversible redaction survives local save,
clipboard, queue restart recovery, and drain consumption without restoring source detail.
`e0b1020` completes HIS-01a's code slice with durable queue timestamps, bounded native
thumbnails, exact local restore, and an explicit production-library route. The next
ordered CAP-02b slice, `ec43534`, now records a privacy-safe rolling set of 20 successful
process-completion-to-native-show durations and surfaces strict `<1s` progress, p50, p90,
and maximum evidence in the tray. The physical 20-capture perceived-latency and native
pasteboard run remains the next foreground gate. The next identity code item is PKG-01a,
but changing the permanent reverse-DNS identity and entitlement manifest requires owner
approval. The native client now has a locally verified authenticated Storage/RPC
transport and an unapplied owner-derived ingest function that atomically produces the
background job. The macOS core now also performs bounded PKCE code exchange and refresh,
stores the rotating session through a Keychain adapter, and converts only a fresh access
token into upload credentials. Startup and successfully queued captures now instantiate
and wake that transport; missing/unsafe build config or a missing session holds every item
without claiming an attempt. The handoff route is locally build-verified but is not deployed
or allowlisted in hosted Auth. The website now has a locally verified permanent-email gate
that clears legacy anonymous browser sessions and opens the same owner-scoped remote store;
the D16 fresh-library policy deliberately performs no anonymous migration. Hosted deployment
and live same-account proof, the physical reconnect drill,
and production migration/deployment remain hard prerequisites before a
native capture can learn with every browser closed. Loop 47
supplies the locally verified one-job Edge worker and unapplied atomic jobs migration;
no migration, function, secret, or schedule has been changed in production.

## 8. Status ledger (update after every loop)

**Current status (2026-08-10):** the web/Supabase demo track advanced far beyond this
ledger's original 2026-07-31 snapshot. Web capture/import, Storage-backed persistence,
real MiniMax classification, correction few-shot context, projects, review, memory,
thread chat, lexical retrieval, annotation, and the Chrome extension are implemented.
The native app now has a tested Tauri command seam, persisted editable global shortcuts,
tray fallbacks, Screen Recording preflight/guidance, capture gating, and a default-off
`SMAppService` Login Item control. Its bundle declares menu-bar-only launch behavior and
macOS 13 minimum support. Successful native captures now persist before an exact-byte
AppKit clipboard write, with cancellation, concurrency, and recoverable failure contracts
tested. Completed captures now also prepare a hidden-until-decode, always-on-top,
nonfocusable overlay on the correct display through the same direct/tray/global path.
That overlay now has generation-safe Copy, atomic Save As, Close, and hover/action-paused
auto-dismiss actions. Successful fresh presentations now also add a privacy-safe
process-completion-to-native-show duration to a restart-safe rolling set of 20, while the
tray reports progress and exact p50/p90/maximum values without storing capture identity or
pixels. This remains instrumentation rather than the physical CAP-02 proof. A native
Recent Captures submenu now discovers the five newest
valid durable PNGs, keeps their queue-originated capture time stable across annotation,
renders bounded native thumbnails, restores an exact item to the cursor display without
changing the pasteboard until Copy, and explicitly opens the production web library. The
thumbnail also starts an exact, copy-only native macOS drag using an isolated friendly-name
proxy and bounded preview;
stale, released, re-pressed, and concurrent gestures are rejected without mutating the
durable UUID original. Every new capture is now file-and-directory synced before an atomic
JSON queue handoff; restart restores FIFO work, reconciles safe orphan UUID PNGs, and keeps
retry/poison/idempotency state without deleting local pixels. Quick Access now opens a
native arrow/box/text/irreversible-pixelate editor that preserves the first original,
atomically replaces the canonical PNG, records flattened queue pixels, re-copies them, and
refreshes the exact overlay presentation. A shared/native golden fixture now proves the
exact irreversible pixels survive command validation, save, clipboard, restart recovery,
and the drain boundary. The queue drain now composes that coordinator with the real
authenticated Storage/RPC transport when a matching fresh Keychain session exists. Startup
and each durably queued capture wake it off the UI thread; absent configuration/session is
an explicit zero-claim hold. Persisted retry deadlines now wake automatically, and known
offline work polls the macOS route at no more than five-second intervals until an
offline-to-online transition wakes the drain; an empty queue sleeps on coalesced events.
Fresh captures also remain unclaimable while Quick Access can
open Annotate, then dismissal or annotation completion releases and wakes the exact item.
The production-compiled coordinator
proves exact-ID completion, no-attempt offline/auth holds, FIFO healthy-work isolation,
single-flight overlap, restart idempotency, and error-safe wake handoff against a fake
transport. A compiled PKCE/ingest boundary now rejects forged/replayed callbacks, keeps
tokens out of URLs and payloads, derives future ownership from authentication, and shares
strict payload fixtures across Rust and Zod. Native email OTP request, HTTPS handoff, strict
deep-link callback, PKCE exchange, Keychain status, and guarded sign-out are connected
locally. Slow Auth HTTP never holds the capture-transition mutex, while sign-out is refused
during an auth operation or queue drain and when uploadable work remains. The current hosted
account still has anonymous sign-in disabled, and its public Data API schema could not be
proven with the configured publishable key. Local source now requires a durable email identity
whenever Supabase is configured and never silently falls back to IndexedDB; the change is not
deployed, so shared cloud behavior is not yet verified. P2 native capture remains the active
risk track under D15's sequencing exception.

Working today (`pnpm dev:web`): capture by drop/paste/button with the four-state overlay, library with real filters, keyboard-first Inbox triage, screenshot detail with prev/next and editable `why_saved`, drag-to-file, ⌘K palette, and the `/memory` surface. Classification calls MiniMax M3 when a key is present and falls back to sample data otherwise — the sidebar says which.

Known blockers:
1. **Native capture path** — the command seam, editable shortcuts, conflict-safe tray
   fallbacks, permission-aware menu lifecycle, persist-first AppKit clipboard path, and
   display-correct overlay with Copy, Save As, Close, auto-dismiss, queue-timestamped
   thumbnail history, exact recent restore, Open Library, native drag-out, durable local
   queue, fake-transport drain coordinator,
   strict auth/ingest contract, native four-tool annotation/flattening, and the exact local
   redaction pixel chain are tested. A latest-20 overlay speed instrument is also wired,
   but the physical 20-capture perceived-latency proof remains. The authenticated runtime
   now wakes at startup and after durable capture enqueue. Native email sign-in can create
   the Keychain session locally, but its HTTPS handoff route is not deployed/allowlisted;
   timed/connectivity retry wakes are locally connected; the physical offline/reconnect drill
   does not exist. Physical
   shortcut, recent-menu thumbnail/relaunch/click/focus, physical annotation
   save/copy/relaunch, downloaded cloud-object,
   relaunch/selection, clipboard, focus, mixed-scale display, permission, Login Item, and
   lifecycle QA also remains.
2. **Mac identity + background worker** — D16 selects a fresh authenticated library rather
   than transferring browser-anonymous data. Email OTP UI, HTTPS handoff, strict token-free deep link,
   PKCE exchange/refresh, Keychain persistence, authenticated upload, and startup/capture
   drain wakes are connected locally. The handoff is not deployed or configured in hosted
   Auth. Website source now requires the same permanent email identity and owner-scoped
   remote store locally, but neither surface has the hosted redirect/deployment proof. Loop 47 adds a
   locally verified one-job Edge classifier with exact owner/storage boundaries, bounded
   context and atomic retries, but its migration is unapplied and it has no deployed
   function or Vault/Cron trigger. Native captures still cannot learn with the web app closed.
3. **Native permission evidence** — Screen Recording and multi-display behavior have not
   passed end-to-end QA from the bundled app.
4. **Distribution** — the local DMG is ad-hoc signed, not notarized, and its current bundle
   identifier is unsuitable. The permanent reverse-DNS identity/entitlement manifest and
   later Developer ID decisions remain owner gates.
5. **Retrieval** — current UI search is lexical; the planned pgvector hybrid path and
   embedding generation are incomplete.

| Phase | Status | Notes |
|---|---|---|
| Planning pack | ✅ complete | 2026-07-31 |
| P0 Foundation | 🟡 partial | scaffold, tray, Supabase and Vercel exist; native email OTP, HTTPS/deep-link PKCE exchange/refresh, Keychain persistence, guarded sign-out, authenticated drain, and the fresh permanent-email website gate are locally verified, but hosted redirect/deployment proof, CI and telemetry remain |
| Demo track | 🟢 working | remote/local store, web capture, extension, projects, memory, annotation, chat and search surfaces |
| P1 Core backend | 🟡 partial | schema/RLS/Storage live; unapplied jobs + authenticated native-ingest migrations and local Edge worker core exist; production apply, Vault/Cron, generated types and integration proof remain |
| P2 Screenshot ingestion | 🟡 active | web/extension ingest plus native command/editable-shortcut/tray/permission, AppKit clipboard, interactive overlay, drag-out, five-item recent restore, four-tool annotation/flattening, durable local queue, native email session creation, and startup/capture/deadline/reconnect-woken authenticated Storage/RPC drain; hosted redirect/data proof, offline drill, and native QA remain |
| P3 OCR/classification | 🟡 partial | browser MiniMax path works; local server worker/ingest core now passes 19 Deno tests, but hosted integration and embeddings do not exist |
| P4 Project threads | 🟡 partial | web projects, routing and correction ledger work; native overlay exists but suggestion/thread actions remain |
| P5 Chat retrieval | 🟡 partial | web chat/citations work over client-assembled retrieval; server tool path remains |
| P6 Search | 🟡 partial | CJK-aware lexical retrieval works; vector/date hybrid gates remain |
| P7 Polish + dogfood gate | 🟡 partial | web/native annotation and native menu/login/permission guidance exist; full onboarding, native QA, signed DMG and five-day dogfood remain |
| P8 Billing | 🅿 parked | build only when external users exist |
