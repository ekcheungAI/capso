# 12 — Mac App Plan (Capso menu-bar capture client)

> Product name "Capso" is a working name, unconfirmed — treat as an assumption throughout.
> Scope: the Tauri 2 menu-bar Mac app. In MVP it is a **capture-only client**: capture, annotate, queue, upload, deep-link. All library/browse/search/chat lives in the web app (see 13_WEB_APP_PLAN.md). Capture UX details: see 05_FEATURE_SPEC_CAPTURE.md. Design language: see 15_DESIGN_SYSTEM_AND_UX.md.

## Assumptions

- Owner-user is Elvin on macOS (Apple Silicon), single account, own Supabase project. No multi-user concerns in MVP.
- `screencapture` CLI is acceptable capture quality for MVP; native ScreenCaptureKit is a post-MVP swap behind the same internal interface.
- App distributed as a manual `.dmg` for personal use first; no App Store.
- Network is usually available; offline is the exception, not the norm.

## Out of scope (MVP)

- Scrolling capture, screen recording, GIF (post-MVP — locked decision).
- Automatic clipboard watching (post-MVP, privacy-sensitive).
- Sensitive-content exclusion / app blocklist (post-MVP).
- Any local library UI, local search, or local AI. Mac app never calls the AI provider directly — upload to Supabase, Edge Functions do the rest (see 09_AI_SYSTEM_AND_MODEL_ROUTING.md and 14_BACKEND_AND_STORAGE.md).
- Auto-update (post-MVP acceptable; see below).

## Capture methods (Requirement)

| Method | Default hotkey | Mechanism | Notes |
|---|---|---|---|
| Region capture | ⌃⇧C | `screencapture -i <file>` (interactive crosshair) | Native macOS picker; Esc cancels cleanly |
| Window capture | ⌃⇧W | `screencapture -iw <file>` (window picker) | Space toggles window mode natively |
| Save clipboard image | menu item | Read NSPasteboard image → write PNG to temp dir | MVP is manual action only |
| Drag & drop | tray icon / drop window | File drop → copy into temp dir | Accepts png/jpg/webp only in v1 |

- Hotkeys registered via the Tauri global-shortcut plugin; **configurable** in Settings (stored in local config JSON). Defaults above are requirements; specific alternates are user choice.
- Flow: hotkey → shell out to `screencapture` writing into a **watched temp dir** (`~/Library/Application Support/Capso/pending/`) → file-watcher picks up the new file → ingest pipeline (annotate option → clipboard copy → queue → upload → overlay).
- Every capture is **copied to clipboard immediately** on completion (CleanShot parity, locked decision).

## Post-capture flow (Requirement)

1. File lands in watched dir → floating thumbnail overlay appears bottom-right (always-on-top, non-activating panel).
2. Background upload to Supabase Storage starts immediately; overlay shows `uploading` state.
3. Edge Function runs the single Haiku-class vision call; overlay receives Project/Type suggestion chip via Realtime within ~3–5 s target.
4. User: one-click **confirm**, **adjust** (small picker), or **ignore/dismiss** → capture goes to Inbox unassigned. Confidence thresholds (≥0.8 auto-assign, 0.5–0.8 suggest, <0.5 Inbox) are decided in shared context; overlay reflects them.
5. **Ask AI** button on overlay → deep-links to web app thread chat with screenshot attached (`https://<app-domain>/t/<thread_id>?attach=<capture_id>`, exact routes in 13_WEB_APP_PLAN.md).
6. Overlay auto-dismisses after confirm or ~12 s idle (idea: configurable timeout — adjustable).

Quick annotation editor (arrow / box / text / blur) opens from an overlay button **before** upload finalizes the image; annotated version replaces the original in the queue. Editor spec: see 05_FEATURE_SPEC_CAPTURE.md.

## Menu bar behavior (Requirement)

Tray icon states:

| State | Icon | Trigger |
|---|---|---|
| Idle | static glyph | Nothing pending |
| Uploading | subtle animated/badged glyph | ≥1 item in upload queue |
| Attention | dot badge | Failed upload, missing permission, or auth expired |

Menu items (top to bottom):

1. Capture Region (⌃⇧C)
2. Capture Window (⌃⇧W)
3. Save Clipboard Image
4. Open Capso (web) — opens web app in default browser
5. Recent Captures — last 5 thumbnails, click → opens that capture's detail page in web
6. Pause AI Processing — toggle; captures still upload but are flagged `ai_paused`, processed on resume (server-side flag)
7. Settings…
8. Quit

A small **drop window** (open via tray menu or dragging onto tray icon) accepts image file drops → same ingest pipeline as capture. Idea: also register as a share/services target — post-MVP.

## Shortcuts table

| Action | Default | Configurable |
|---|---|---|
| Capture region | ⌃⇧C | Yes |
| Capture window | ⌃⇧W | Yes |
| Save clipboard image | none (menu only) | Yes (optional binding) |
| Open web app | none (menu only) | Yes (optional binding) |

Conflict handling: if registration fails (shortcut taken), show attention state + Settings hint; never silently drop.

## Local upload queue (Requirement)

- Store: SQLite (preferred; via Tauri SQL plugin) in `~/Library/Application Support/Capso/queue.db`. JSON-file queue is an acceptable fallback if SQLite integration costs >0.5 day.
- Row: `id, file_path, created_at, status (pending|uploading|uploaded|failed), attempts, last_error, ai_paused`.
- Offline or failure → status `pending/failed`, retry with exponential backoff (5s, 30s, 2m, 10m, then hourly; cap 24h, then attention state).
- Overlay and tray reflect queued state ("Saved — will upload when online").
- Local file deleted only after confirmed upload + DB row in Supabase; otherwise retained (queue dir is the durability layer).

## Sync behavior (Requirement)

- Mac app is capture-only. No local library, no bidirectional sync. Source of truth = Supabase.
- Recent Captures menu reads from the local queue table (last 5 uploaded/pending), not from the server — keeps the menu instant and offline-safe.
- All deep links go to the web app; the Mac app never renders library views in MVP.

## Failure states (Requirement)

| Failure | User-visible behavior | Recovery |
|---|---|---|
| Screen Recording permission missing | Capture aborts; overlay-style alert "Capso needs Screen Recording" with **Open System Settings** button; tray → attention | User grants in System Settings → Privacy & Security; app detects on next capture attempt (no restart needed if possible; if macOS requires relaunch, prompt to relaunch) |
| Offline at capture | Capture succeeds locally; overlay shows "Saved — queued"; clipboard copy still works | Auto-retry with backoff; queue flushes on reconnect |
| Upload fails (server/auth error) | Overlay/tray attention; Recent Captures shows failed badge | Auto-retry; "Retry now" in tray menu; if auth expired → "Sign in again" opens web auth flow |
| AI suggestion timeout (>10 s) | Overlay drops the chip slot, shows "Sent to Inbox — classify later"; capture is safely uploaded | Classification completes server-side whenever it lands; web Inbox is the catch-all |
| `screencapture` exits non-zero / user Esc | Silent no-op for Esc; error toast for real failures | Re-invoke hotkey |
| Temp dir unwritable / disk full | Alert with path shown | User frees space; captures blocked until resolved |

## macOS permissions (Requirement)

| Permission | Needed for | When asked |
|---|---|---|
| Screen Recording | Window capture; `screencapture` in some paths | First-run onboarding: explain → trigger prompt via a throwaway 1px capture → verify → green check. If denied: persistent attention state + settings deep-link |
| Notifications | Optional: upload-failure notices | Ask lazily, first time a background failure occurs; never on first run |
| Login Item (auto-start) | Menu-bar app always available | Onboarding asks explicitly ("Start Capso at login?"); default off until user says yes |

First-run flow: welcome → sign in (Mac-originated PKCE opens web auth; `capso://auth/callback` returns only a one-time code + state; native exchange stores the session in Keychain) → Screen Recording walkthrough → optional login item → prompt first capture (⌃⇧C). Access and refresh tokens never travel in a URL or through the webview.

## Auto-update & distribution

- MVP: manual `.dmg` builds for personal use (Requirement). Version shown in Settings.
- Post-MVP: Tauri updater with signed update manifests (idea — acceptable to defer).
- **Code signing + notarization note (Requirement):** Developer ID signing and Apple notarization are mandatory **before any external tester** receives a build — unsigned builds trip Gatekeeper and the Screen Recording permission UX becomes unreliable. For Elvin-only use, ad-hoc/local signing is fine. Budget ~0.5 day + Apple Developer account when the time comes.

## Analytics & errors

- PostHog: capture_started, capture_completed, suggestion_shown, suggestion_confirmed/adjusted/ignored, ask_ai_clicked, queue_retry. No screenshot content ever sent to analytics (Requirement).
- Sentry for Rust + webview errors.

## Build-order note

Implementation sequencing lives in 19_BUILD_SEQUENCE.md; this doc is the behavioral contract.
