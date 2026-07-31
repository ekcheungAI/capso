# 05 — Feature Spec: Capture

> Capso (working name — see Assumptions). This doc specifies everything between "user presses hotkey" and "PNG lands in Supabase Storage + AI pipeline kicks off". Downstream AI behavior: see `06_FEATURE_SPEC_AI_MEMORY.md`. Thread assignment: see `07_FEATURE_SPEC_PROJECT_THREADS.md`. Offline/queue internals: see `12_MAC_APP_PLAN.md`. Data shapes: see `10_DATA_MODEL.md`.

> **Resolved 2026-07-31:** overlay sits **bottom-right**, matching `specs/user_flows.md` F1 (this doc previously said bottom-left). Built and verified in the web demo.
> **Resolved 2026-07-31:** the overlay action row includes **Ignore**, which F2/F4 assumed but this doc's action table omitted.

## Assumptions

- "Capso" is a working name, unconfirmed. No branding decisions are load-bearing in this doc.
- macOS 13+ on the owner-user's machines; Screen Recording permission is grantable and stays granted.
- `screencapture` CLI remains available and stable (it is a macOS system binary; low risk).
- Single user (Elvin) in MVP; all captures belong to one Supabase auth user.

## Goal (requirement)

Cancel the CleanShot X subscription without losing the daily-driver capture habits: region capture, window capture, copy-to-clipboard, quick annotate, floating thumbnail. Everything else CleanShot does is either deferred or deliberately never copied (see parity table).

## 1. Capture entry points

| Entry point | Default trigger | Mechanism | MVP? |
|---|---|---|---|
| Region capture | ⌃⇧C (configurable) | Tauri global shortcut → shell out to `screencapture -i <tmpfile>` | Yes (requirement) |
| Window capture | ⌃⇧W (configurable) | Global shortcut → `screencapture -iw <tmpfile>` | Yes (requirement) |
| Drag image into app | Drag onto Tauri menu-bar window or web app drop zone | File drop event → same ingestion path as capture | Yes (requirement) |
| Save clipboard | Menu-bar item "Save clipboard image" + hotkey ⌃⇧V (configurable) | Read NSPasteboard image → ingestion path | Yes (requirement) |
| Auto clipboard-watch | — | Poll/observe pasteboard, auto-ingest images | Post-MVP, OFF by default (requirement) |
| Scrolling capture | — | — | Deferred post-MVP (locked decision) |
| Screen recording / GIF | — | — | Deferred post-MVP (locked decision) |

Hotkey rules (requirement):
- Defaults are suggestions; both hotkeys editable in Settings. Detect conflicts with CleanShot X / macOS defaults and warn (idea: auto-suggest free combo).
- Hotkeys registered via Tauri 2 global-shortcut plugin; must work when app has no focused window (menu-bar app).

### Capture mechanics (requirement)

1. Hotkey fires → write target path `~/Library/Application Support/Capso/captures/<uuid>.png` → spawn `screencapture -i` (or `-iw`) with that path. macOS draws its own crosshair/window-picker UI; we do not build one for MVP.
2. Process exit + file exists → capture succeeded. File missing → user pressed Esc; do nothing silently.
3. On success, atomically: (a) if copy-to-clipboard is ON, put image on pasteboard; (b) show floating overlay (§2); (c) enqueue upload job (background); (d) keep local original until upload confirmed (see `12_MAC_APP_PLAN.md` for queue/retry).

Copy-to-clipboard toggle (requirement): global setting, default ON (matches CleanShot muscle memory). Overlay also has a per-capture "Copy" action regardless of setting.

## 2. Post-capture overlay (requirement — this is the product's signature moment)

CleanShot-style floating thumbnail, bottom-right of the active display, ~200px wide, drop shadow, floats above all windows (non-activating panel — must not steal focus).

### Lifecycle

1. **Appear**: slides in immediately after capture. Shows thumbnail + action row.
2. **Uploading**: thin progress bar on thumbnail edge. Upload is background; user never waits on it.
3. **AI chip states** (inline chip under thumbnail):
   - `loading` — subtle shimmer "Analyzing…" (target: replaced within ~3–5s of capture; hard timeout 12s).
   - `suggestion` — chip shows `Project: X · Type: Y` with two buttons: ✓ confirm, ⌄ adjust (dropdown of existing threads + "New thread…" + intent picker). Shown when confidence 0.5–0.8 (see `06_FEATURE_SPEC_AI_MEMORY.md` for thresholds).
   - `confirmed` — chip turns solid, shows assigned thread. Auto-shown directly when confidence ≥0.8 (auto-assign, still editable via ⌄).
   - `timeout/error` — chip shows "Saved to Inbox"; classification retries server-side; no user action needed.
4. **Dismiss**: overlay auto-dismisses after 8s of no interaction (timer pauses on hover). Swipe-right / click X dismisses immediately. **Dismissal never loses data** (requirement): the capture is already saved; unconfirmed suggestions <0.8 fall back to Inbox; ≥0.8 auto-assignments stick.

### Overlay actions

| Action | Control | Keyboard |
|---|---|---|
| Confirm AI suggestion | ✓ on chip | ⏎ |
| Adjust project/type | ⌄ dropdown | ⌘⏎ opens picker |
| Ask AI (opens thread chat with this screenshot attached — see `07_FEATURE_SPEC_PROJECT_THREADS.md`) | "Ask AI" button | ⌘A |
| Annotate | pencil icon → quick editor (§3) | ⌘E |
| Copy to clipboard | copy icon | ⌘C |
| Delete capture | trash icon (with 5s undo toast) | ⌘⌫ |
| Dismiss overlay | X / swipe | Esc |

Keyboard shortcuts work only while overlay is frontmost-hovered or within 3s of appearing (avoid hijacking global keys) — implementation detail for `12_MAC_APP_PLAN.md`.

## 3. Basic annotation editor (requirement)

Quick editor window opened from the overlay (or later from any screenshot detail view on web). Scope is deliberately minimal:

- **Tools**: arrow, rectangle box, text label, blur (pixelate) region. Nothing else in MVP — no highlighter, counter badges, cropping, or color themes beyond a small preset palette (red default + 4 colors).
- **Behavior**: annotations are vector objects while the editor is open (move/delete/undo ⌘Z). On save, annotations are **flattened into the uploaded PNG** (requirement). The pre-annotation original is preserved locally until upload of the annotated version succeeds, then MVP keeps only the annotated PNG in cloud. (Idea, post-MVP: store original + annotation JSON layer for re-editing.)
- **Blur caveat** (requirement): blur is pixelation baked into pixels — document in-app that OCR runs on the *uploaded* image, so blurred regions are excluded from memory. This is the poor man's sensitive-exclude until the post-MVP privacy toggles land (locked decision #4).
- Save → replaces the pending upload payload; re-runs nothing if AI pass already completed on the original (MVP accepts this mismatch; flagged as known limitation — idea: re-trigger cheap pass on annotated saves that contain blur).

## 4. Ingestion paths (non-hotkey)

All paths converge on the same pipeline: local file → `screenshots` row (capture_kind = `screenshot`) → Storage upload → cheap AI pass. `capture_kind` is an enum (`screenshot | link | pdf | file`) — only `screenshot` implemented in v1 (locked decision #1); others exist in schema only (see `10_DATA_MODEL.md`).

- **Drag into Mac app**: menu-bar window accepts image drops (png/jpg/webp). Non-image files rejected with toast "Screenshots only for now".
- **Web app drop zone**: full-page drop target on the library view; same validation; uploads directly to Supabase Storage from browser, then invokes the same Edge Function pipeline.
- **Save clipboard**: manual action; reads current pasteboard image; errors gracefully if pasteboard has no image. Auto-watch is post-MVP and ships OFF by default (requirement — privacy posture).

## 5. Failure behavior (summary — full spec in `12_MAC_APP_PLAN.md`)

- **Offline / upload fails**: capture saved locally, queued in a durable on-disk queue, retried with backoff; overlay chip shows "Saved locally — will sync". AI chip skips to timeout state.
- **AI call fails / slow**: never blocks save. Item lands in Inbox; server-side job retries classification (jobs table + pg_cron).
- **`screencapture` returns non-zero / no file**: treated as user cancel unless stderr indicates permission error → show one-time prompt directing user to System Settings → Screen Recording.
- **Disk-full / permission-denied writing tmp file**: hard error notification; nothing silently dropped.

## 6. CleanShot X parity table (requirement)

| Feature | CleanShot X | Capso MVP | Capso later | Never |
|---|---|---|---|---|
| Region capture (hotkey) | ✓ | ✓ | | |
| Window capture | ✓ | ✓ | | |
| Fullscreen capture | ✓ | via region (select all) | dedicated hotkey | |
| Copy to clipboard | ✓ | ✓ | | |
| Floating thumbnail overlay | ✓ | ✓ (+ AI chip — beyond parity) | | |
| Annotate: arrow/box/text/blur | ✓ | ✓ | more tools (highlight, counters, crop) | |
| Scrolling capture | ✓ | ✗ | ✓ post-MVP | |
| Screen recording (video) | ✓ | ✗ | ✓ post-MVP | |
| GIF recording | ✓ | ✗ | maybe | |
| Self-timer capture | ✓ | ✗ | maybe | |
| Cloud upload + share link | ✓ (CleanShot Cloud) | upload yes; public share links no | share links post-MVP | |
| Capture history browser | ✓ (limited) | ✓✓ (full searchable memory — beyond parity) | | |
| Hide desktop icons | ✓ | | | ✗ never — off-mission utility |
| Wallpaper tool / custom backdrops behind screenshots | ✓ | | | ✗ never — cosmetic, mymind-calm ethos says no |
| Pin screenshot to screen | ✓ | ✗ | maybe | |
| OCR "copy text from image" | ✓ | ✓ (from AI pass; copy OCR text in detail view) | on-device instant OCR | |
| Multi-display / advanced capture settings matrix | ✓ | system defaults only | | ✗ never as a settings surface — keep settings tiny |

**Deliberately not copied** (requirement): desktop-icon hiding, wallpaper/backdrop styling, and the sprawling preferences surface. Capso's differentiation is memory, not capture-utility maximalism. Every CleanShot feature we skip must be justified by "does its absence break the daily habit?" — the four in the Never column do not.

## Out of scope for this doc

- Classification prompt/JSON contract → `06_FEATURE_SPEC_AI_MEMORY.md`
- Thread suggestion mechanics and chat → `07_FEATURE_SPEC_PROJECT_THREADS.md`
- Search → `08_FEATURE_SPEC_SEARCH_AND_RETRIEVAL.md`
- Offline queue implementation, permissions onboarding, notarization → `12_MAC_APP_PLAN.md`
- Billing/quotas (documented, not built) → pricing doc
