# Capso Mac capture client

Tauri 2 menu-bar client for Capso's native screenshot workflow.

## Native capture command

The Rust backend exposes `capture_screen` with one argument:

```ts
type CaptureMode = "region" | "window" | "fullscreen";
```

Successful captures return:

```json
{
  "status": "captured",
  "path": "…/com.capso.app/captures/<uuid>.png",
  "clipboard": { "status": "copied", "bytes": 123456 },
  "overlay": { "status": "prepared", "x": 1440, "y": 900 },
  "queue": { "status": "enqueued", "id": "<uuid>", "queued": 1 }
}
```

The PNG file and its containing directory are synced before Capso reports it as durable. Capso then commits the local queue handoff before attempting the clipboard or overlay. If queue persistence, AppKit, or overlay publication fails, the command remains a successful capture and reports that post-capture failure under `queue`, `clipboard`, or `overlay`; stored pixels are never deleted or downgraded. Pressing Escape in an interactive picker returns `{ "status": "cancelled" }`, never schedules a clipboard mutation, and is not an error. Storage, launch, empty-output, permission, concurrent-capture, and diagnostic failures reject with `{ "code", "message" }`.

Mode mapping:

- `region`: macOS interactive selection only.
- `window`: macOS interactive window selection only.
- `fullscreen`: main display capture. Multi-display selection is a later CAP-01 objective.

The command runs `/usr/sbin/screencapture` on Tauri's blocking executor and writes pixels into the application-data `captures/` directory before reporting success. It then reads and validates that persisted PNG off the UI thread and writes the exact bytes to macOS `NSPasteboard` on the main thread. The user-facing default-on copy toggle and background AI remain separate objectives. Native general-pasteboard copy/paste still requires manual QA.

## Durable capture queue

Every new native capture is handed to an atomic JSON queue at `$APPDATA/upload-queue.json` immediately after the PNG becomes durable. Each record keeps the capture UUID, protected path, capture source, timestamp, state, attempt count, retry deadline, and last error. Queue updates write and sync a unique sibling temporary file, rename it over the queue document, and sync the containing directory. A failure before rename rolls memory back; a failure after a visible rename is reported but keeps the in-memory record so an exact retry remains idempotent.

Startup validates the whole queue before changing it. Corrupt, unsupported, duplicate, path-unsafe, or internally inconsistent documents are preserved and surface a tray warning instead of being overwritten. Valid interrupted uploads return to the 5-second, 30-second, or 2-minute retry deadline for their attempt; the fourth interrupted/failed attempt becomes terminal and cannot block later FIFO work. Direct, non-empty canonical UUID PNGs left by a crash before handoff are recovered once with an honest `recovered` source. Missing captures remain visible as terminal records. Completed records are never reclaimed, and no queue transition deletes the local PNG.

The production-compiled drain coordinator now consumes that state machine through a narrow upload-transport contract. Only an acknowledgement carrying the exact claimed capture UUID can complete an item. Retryable failures and mismatched acknowledgements enter the existing backoff without blocking later healthy FIFO work; offline or credential holds do not consume an attempt. Explicit startup, enqueue, reconnect, credential-restored, and retry-deadline wakes are single-flight, and overlapping wakes are handed to a follow-up pass even when the active pass errors. The transport call runs outside the queue lock, and uploaded records still retain their protected local PNG.

The app wires this coordinator to connectivity/retry wakes and an authenticated Supabase transport. It retrieves a Keychain-backed session, generates a bounded PNG thumbnail, uploads the exact original and thumbnail to owner-scoped private Storage paths, then calls the authenticated ingest RPC that atomically creates the screenshot and processing job. Missing credentials hold without consuming an attempt; transient failures back off; exact acknowledgements complete only the matching queue item.

This source path is locally verified, but hosted readiness is separate: the jobs/native-ingest migrations, Edge worker secret/function, and scheduled wake still require an owner-approved deployment and an exact three-capture offline/restart/reconnect proof. Until that drill passes, local queue durability is proven but the production cloud loop is not claimed end to end.

## Native auth and ingest contract

The Rust app now compiles a provider-neutral PKCE handoff boundary. Capso creates and retains a high-entropy verifier, exposes only its S256 challenge and a separate state value to the browser, and accepts only the literal `capso://auth/callback?code=…&state=…` shape. Raw control characters, normalized path tricks, fragments, duplicate/unknown query fields, token-bearing URLs, expired handoffs, wrong state, and local replay are rejected. Authorization codes are treated as bounded opaque printable data; the verifier and code are redacted from debug output.

The matching authenticated-ingest boundary accepts only a client-stable screenshot UUID, `originals/<authenticated-owner>/<screenshot-id>.png`, a strict seconds-bearing RFC 3339 timestamp, a known native source, a lowercase SHA-256, and bounded pixel/byte dimensions. No caller `user_id` exists. Only an acknowledgement naming the exact capture can complete future queue work; authentication and Storage-quota failures remain held without spending an attempt, transient failures retry, and terminal contract failures stay isolated.

Rust and the shared Zod package consume one strict fixture plus shared negative timestamp/message boundaries. The app now registers the `capso://` callback, starts browser PKCE sign-in, exchanges the authorization code, stores the refresh session in Keychain, refreshes expiring credentials, uploads through the real HTTP adapter, and wakes the durable drain on startup, enqueue, reconnect, credentials, and retry deadlines. Ownership always comes from the authenticated server context rather than a caller-supplied field. Hosted migration/function/Cron deployment and the physical installed-app drill remain the boundary before claiming background learning works with every browser closed.

## Capture overlay

Every completed capture prepares the hidden `capture-overlay` webview through the same command path used by direct IPC, tray actions, and global shortcuts. Region and window captures target the display containing the cursor at picker completion; fullscreen captures target the main display to match `screencapture -m`. Rust positions the configured 304×194, 384×244, or 464×294 logical-pixel window inside that display's chosen work-area corner and updates the latest durable capture. The webview reveals only after the new local PNG has decoded and the exact native show call succeeds; only then does the 220ms entrance transition begin, so a previous thumbnail cannot flash and the animation is not spent while the window is hidden. Prepare, exact-path show, and exact-path failure/hide are serialized under one transition lock so stale callbacks cannot race a newer preview. Decode or native show failure keeps the overlay hidden, clears only the matching preview state, and reports the recoverable failure through the tray and `capture-overlay-failed` event while preserving the saved PNG.

The bundled window is hidden by default, transparent, undecorated, non-focusable, always on top, visible across workspaces, and excluded from task surfaces by the menu-bar-only app lifecycle. It accepts deliberate Quick Access clicks without activating Capso. Its asset protocol can read only `$APPDATA/captures/**`; its separate capability grants event access, while the actual export remains a dedicated exact-current Rust command.

The screenshot is full-bleed with no action footer. Hovering reveals exactly two over-image actions: **Copy** re-copies the exact durable PNG, and **Save** exports it directly to the folder, format, and naming template chosen in Settings. Save never opens a file dialog; the folder chooser appears only while changing that destination in Settings. Every capture is already retained automatically in Capso's local History, so the export button does not pretend to be a separate “Save to Capso” or AI-study action. Dragging the thumbnail by at least six logical pixels in any direction starts a copy-only native macOS drag with a bounded 180×112 PNG preview and a local-time `Capso YYYY-MM-DD at HH.mm.ss.png` name. The file handed to the destination is an isolated byte-for-byte proxy under Capso's cache, never the protected UUID original or a hard link. Cancelling cleans the proxy immediately; a successful drop retains it for asynchronous readers and conservative next-launch cleanup.

The overlay auto-dismisses ten seconds after its exact reveal. Mere hover does not pause that deadline, so a stationary pointer cannot keep an untouched preview alive indefinitely; Copy, Save, native drag, and an active swipe pause the remaining duration rather than restarting it. A two-finger horizontal trackpad swipe follows the card to the right and dismisses at 25% width (capped at 96px); a shorter gesture settles back. Physical swipe direction is normalized for either macOS scroll-direction preference. Pointer movement remains exclusively drag-out, so rightward Finder/app drops still work. Presentation/action generations prevent delayed UI responses from changing or dismissing a newer preview, while native path/presentation identities make each drag single-flight and exact. The shared clipboard generation is revalidated at the AppKit mutation point so an older manual copy cannot replace newer captured pixels. Save streams through a same-directory temporary file and atomic rename, so even destination aliases cannot truncate the Application Support PNG. Dismiss, export, and drag failures leave those durable pixels untouched and remain retryable. Reduced Motion removes entrance and settle transitions without removing the actions or dismissal.

OVL-01a placement/configuration/ordering/failure proof remains green. OVL-01b1 adds automated exact-action, exact-byte export, failure-retry, and deterministic pause/reset timer proof; OVL-01b2 adds durable recent restore and native drag-out. Native focus preservation, real Copy/Save/Finder drag behavior, cancel/drop proxy lifecycle, two-display placement with mixed scale factors, and a physical 20-capture perceived-latency run remain manual QA. Annotate remains after the durable-queue ownership seam.

## Overlay speed evidence

Each successful fresh capture records the duration from the return of the native
`screencapture` process until the exact decoded image is successfully shown by the native
overlay. That boundary includes persistence, queue handoff, clipboard delivery, frontend
decode, and native show work. It is the earliest robust command-line boundary available
without requesting Accessibility monitoring; it does not claim to measure the user's raw
mouse-release moment.

Capso keeps only capture mode and duration for the latest 20 successful fresh
presentations. The rolling store is atomically written to
`$APPDATA/overlay-latency.json`; it contains no capture ID, path, timestamp, or image data.
Missing or corrupt evidence recovers safely and produces a generic warning. Stale
presentations, Recent Captures restores, annotation refreshes, decode failures, and native
show failures do not create samples.

The tray's **Overlay Speed Check** submenu shows progress plus nearest-rank p50, p90, and
maximum latency. It passes only when all 20 of the latest 20 samples are strictly below
1,000 ms. This is instrumentation for CAP-02b, not CAP-02 proof by itself: the foreground
20-capture perceived-latency run and real general-pasteboard copy/paste test still have to
pass on the bundled app.

## Recent captures

Every durable capture refreshes a native **Recent Captures** tray submenu. On launch Capso scans `$APPDATA/captures/`, fully decodes candidates, and lists the eight newest valid direct-child `<uuid>.png` files with deterministic ordering. Healthy queue records supply their original capture timestamp, so a later annotation rewrite cannot make an older screenshot look newly captured; local file time remains a recovery fallback if queue metadata is unavailable. Each row carries a native 48×32 aspect-preserving, transparent-letterboxed thumbnail. Missing directories and corrupt, truncated, symlinked, nested, or noncanonical files are ignored. Menu actions contain only an exact UUID; selection re-resolves and revalidates the regular PNG instead of trusting a path or stale list index.

Selecting history restores that PNG to the overlay on the display containing the cursor. The overlay labels it **Recent capture** and **Ready to copy** because selection leaves the macOS pasteboard unchanged until the user presses **Copy**. A native presentation ID protects repeated restores of the same UUID from delayed callbacks. Clipboard identity and history overlay publication share one transaction, so a concurrent fresh capture either wins first and rejects the restore or follows it and safely supersedes both states. The separate **Open Library…** item opens `https://capso-cyan.vercel.app/library` only after an explicit click; constructing or opening the history menu performs no network request.

Automated restart-equivalent queue timestamps, bounded thumbnail generation, disk discovery, full-decode validation, exact-ID resolution, fixed library routing, repeated-path callbacks, and both fresh/history ordering directions are covered. Native relaunch population, thumbnail appearance, real tray selection/library opening, cursor-display placement, focus preservation, and general-pasteboard behavior still require manual QA before HIS-01 or OVL-01 passes.

## Global capture entry points

Capso registers the three capture shortcuts from Rust at startup:

| Capture | Default | Tray fallback |
|---|---|---|
| Region | ⌘⇧4 | Capture Region |
| Window | ⌃⇧W | Capture Window |
| Main-display fullscreen | ⌃⇧F | Capture Fullscreen |

The tray also exposes **Capture Region in 5 Seconds** for menu and hover states. The timer is single-flight: a second request cannot start an overlapping picker. A small always-on-top surface shows the live `5 → 1` countdown without taking focus; **Cancel** stops the sleeping timer before it can launch the picker, and Escape also cancels after the timer surface has keyboard focus. The menu-bar tooltip remains a secondary status channel.

Shortcut registration is isolated per action. If another app already owns one default, Capso keeps the other shortcuts active, identifies the unavailable shortcut in the tray menu and tooltip, and leaves every capture mode available from the menu. Shortcut presses trigger only once on the key-down event. Direct commands, tray actions, and global shortcuts converge on the same RAII single-flight lease, so overlapping native pickers and out-of-order clipboard writes are rejected consistently.

Left-click the Capso menu-bar icon to edit all three bindings. Each recorder temporarily unregisters the active global bindings before listening, accepts a real modified key combination, restores the old bindings on cancel/blur, validates that bindings are unique, and saves them to `~/Library/Application Support/com.capso.app/shortcut-settings.json`. A save first registers the complete candidate set and only then atomically replaces the JSON. Registration or storage failure rolls back to the previously active set; Capso reconciles partial OS rollback failures, keeps the tray capture actions available, and offers an unchanged retry.

The plugin is used entirely from Rust, so no global-shortcut commands are exposed to the webview and no frontend capability permission is enabled. The native result is emitted as an explicitly tagged `capture-finished` payload: top-level `captured`, `cancelled`, or `failed`. A clipboard failure remains top-level `captured` and carries its recoverable status under `clipboard`. Physical recording, relaunch persistence, any-foreground-app dispatch, real cross-app conflicts, rollback messaging, picker behavior, and general-pasteboard copy/paste still require manual QA before CAP-01 can pass.

## Pin to screen

The capture overlay can turn the exact active capture into one reusable, always-on-top pinned window. Pinning a newer capture replaces the previous pin; delayed image, copy, or close actions are rejected by presentation ID. The pin is resizable, visible across workspaces, provides Copy and Close controls, and closes with Escape once focused without changing or deleting the durable original. This is intentionally a one-pin v1 and does not persist across app restarts. Native focus, keyboard-only pin invocation, and repeated physical pin/copy/close testing remain required before claiming CleanShot pin parity.

## Menu lifecycle and macOS permissions

Capso is packaged as an agent app (`LSUIElement=true`), applies Tauri's Accessory activation policy, hides its popover on close, and remains available from the menu bar until **Quit Capso** is chosen. The bundle declares macOS 13 as its minimum because the Login Item control uses Apple's `SMAppService`.

Screen Recording status is checked without prompting at startup and whenever the popover regains focus. Every screenshot mode is blocked before `/usr/sbin/screencapture` can run when the current installed build lacks effective authorization; a shortcut or tray attempt opens visible recovery instead of saving blank pixels. Region capture still uses macOS's live native area picker once authorized. If a picker returns no pixels and permission was lost during the interaction, Capso reports permission recovery rather than treating the result as Escape. The OS prompt only follows an explicit **Grant access** action and is attempted at most once per app session. A denied request becomes **Open settings**, followed by a real **Restart Capso** action because closing the Settings window does not quit this menu-bar process.

macOS privacy access follows the app's code-signing identity, not its visible name. `SystemStatus` distinguishes a stable team identity from an ad-hoc build and explains when System Settings may be showing an older Capso build as enabled. Before installing any build for permission QA, run `pnpm --filter mac verify:screen-recording-identity /path/to/Capso.app`; it rejects ad-hoc signatures, missing TeamIdentifiers, and CDHash-only designated requirements. A valid Apple Development identity is sufficient for persistent local QA; distribution still requires the permanent bundle identifier, Developer ID Application signing, and notarization.

**Launch at login** is off unless the user explicitly enables it. Capso reads, registers, and unregisters the main-app Login Item through `SMAppService`, represents macOS' approval-required state honestly, and provides an explicit route to Login Items. It does not install a hidden LaunchAgent and never requests Accessibility access.

Native permission grant/revoke, Login Item enable/disable plus relaunch, Dock/app-switcher absence, and signed installed-bundle behavior still require manual QA before UX-01 can pass.

## Commands

```bash
pnpm --filter mac typecheck
pnpm --filter mac build
cargo test --manifest-path apps/mac/src-tauri/Cargo.toml
cargo clippy --manifest-path apps/mac/src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
pnpm --filter mac tauri build --debug --bundles app
```

### Cloud sync and native sign-in need build-time configuration

`build.rs` reads `CAPSO_SUPABASE_URL`, `CAPSO_SUPABASE_PUBLISHABLE_KEY`, and
`CAPSO_AUTH_SITE_URL` from the **process environment at compile time**; it does not read
`.env.local`. The commands above therefore produce an app that cannot sign in or sync,
with no runtime error — `embedded_public_config()` simply reports no configuration.

To build or run a cloud-enabled app, use the wrapper, which loads `.env.local` and
exports only those three public values:

```bash
scripts/mac-cloud.sh dev      # run it
scripts/mac-cloud.sh build    # debug .app bundle
```

The publishable key must start with `sb_publishable_`; a legacy anon JWT and any
`sb_secret_`/service-role key are rejected before compilation.
