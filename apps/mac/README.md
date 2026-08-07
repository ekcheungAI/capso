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
  "overlay": { "status": "prepared", "x": 1440, "y": 900 }
}
```

The PNG is durable before Capso attempts the clipboard write. If AppKit rejects that post-capture step, the command remains a successful capture and returns `"clipboard": { "status": "failed", "code", "message" }`; the stored pixels are not deleted or downgraded. Pressing Escape in an interactive picker returns `{ "status": "cancelled" }`, never schedules a clipboard mutation, and is not an error. Storage, launch, empty-output, permission, concurrent-capture, and diagnostic failures reject with `{ "code", "message" }`.

Mode mapping:

- `region`: macOS interactive selection only.
- `window`: macOS interactive window selection only.
- `fullscreen`: main display capture. Multi-display selection is a later CAP-01 objective.

The command runs `/usr/sbin/screencapture` on Tauri's blocking executor and writes pixels into the application-data `captures/` directory before reporting success. It then reads and validates that persisted PNG off the UI thread and writes the exact bytes to macOS `NSPasteboard` on the main thread. The user-facing default-on copy toggle, upload queue, and background AI remain separate objectives. Native general-pasteboard copy/paste still requires manual QA.

## Capture overlay

Every completed capture prepares the hidden `capture-overlay` webview through the same command path used by direct IPC, tray actions, and global shortcuts. Region and window captures target the display containing the cursor at picker completion; fullscreen captures target the main display to match `screencapture -m`. Rust positions the 252×194 logical-pixel window inside that display's bottom-right work area and updates the latest durable capture. The webview reveals only after the new local PNG has decoded, so a previous thumbnail cannot flash; prepare, exact-path show, and exact-path failure/hide are serialized under one transition lock so stale callbacks cannot race a newer preview. Decode or native show failure keeps the overlay hidden, clears only the matching preview state, and reports the recoverable failure through the tray and `capture-overlay-failed` event while preserving the saved PNG.

The bundled window is hidden by default, undecorated, non-focusable, always on top, visible across workspaces, and excluded from task surfaces by the menu-bar-only app lifecycle. It accepts deliberate Quick Access clicks without activating Capso. Its asset protocol can read only `$APPDATA/captures/**`; its separate capability grants event access and only the official Tauri Save dialog, while the actual export remains a dedicated exact-current Rust command.

The action footer can re-copy the exact durable PNG, export its exact bytes through an explicit **Save As…** dialog, or close the exact active preview. Dragging the thumbnail by at least six logical pixels starts a copy-only native macOS drag with a bounded 180×112 PNG preview and a local-time `Capso YYYY-MM-DD at HH.mm.ss.png` name. The file handed to the destination is an isolated byte-for-byte proxy under Capso's cache, never the protected UUID original or a hard link. Cancelling cleans the proxy immediately; a successful drop retains it for asynchronous readers and conservative next-launch cleanup.

The overlay auto-dismisses eight seconds after decode; hovering or opening an action, including a native drag session, pauses the remaining duration rather than restarting it. Presentation/action generations prevent delayed UI responses from changing a newer preview, while native path/presentation identities make each drag single-flight and exact. The original mouse-down counter must also remain unchanged through off-thread preview preparation, so release or release-then-repress cannot revive a stale drag. The shared clipboard generation is revalidated at the AppKit mutation point so an older manual copy cannot replace newer captured pixels. Save As streams through a same-directory temporary file and atomic rename, so even destination aliases cannot truncate the Application Support PNG. Dismiss, export, and drag failures leave those durable pixels untouched and remain retryable.

OVL-01a placement/configuration/ordering/failure proof remains green. OVL-01b1 adds automated exact-action, exact-byte export, failure-retry, and deterministic pause/reset timer proof; OVL-01b2 adds durable recent restore and native drag-out. Native focus preservation, real Copy/Save/Finder drag behavior, cancel/drop proxy lifecycle, two-display placement with mixed scale factors, and perceived appearance latency remain manual QA. Annotate remains after the durable-queue ownership seam.

## Recent captures

Every durable capture refreshes a native **Recent Captures** tray submenu. On launch Capso scans `$APPDATA/captures/`, fully decodes candidates, and lists the five newest valid direct-child `<uuid>.png` files with deterministic ordering. Missing directories and corrupt, truncated, symlinked, nested, or noncanonical files are ignored. Menu actions contain only an exact UUID; selection re-resolves and revalidates the regular PNG instead of trusting a path or stale list index.

Selecting history restores that PNG to the overlay on the display containing the cursor. The overlay labels it **Recent capture** and **Ready to copy** because selection leaves the macOS pasteboard unchanged until the user presses **Copy**. A native presentation ID protects repeated restores of the same UUID from delayed callbacks. Clipboard identity and history overlay publication share one transaction, so a concurrent fresh capture either wins first and rejects the restore or follows it and safely supersedes both states.

Automated restart-equivalent disk discovery, full-decode validation, exact-ID resolution, repeated-path callbacks, and both fresh/history ordering directions are covered. Native relaunch population, real tray selection, cursor-display placement, focus preservation, and general-pasteboard behavior still require manual QA before HIS-01 or OVL-01 passes.

## Global capture entry points

Capso registers the three capture shortcuts from Rust at startup:

| Capture | Default | Tray fallback |
|---|---|---|
| Region | ⌃⇧C | Capture Region |
| Window | ⌃⇧W | Capture Window |
| Main-display fullscreen | ⌃⇧F | Capture Fullscreen |

Shortcut registration is isolated per action. If another app already owns one default, Capso keeps the other shortcuts active, identifies the unavailable shortcut in the tray menu and tooltip, and leaves every capture mode available from the menu. Shortcut presses trigger only once on the key-down event. Direct commands, tray actions, and global shortcuts converge on the same RAII single-flight lease, so overlapping native pickers and out-of-order clipboard writes are rejected consistently.

Left-click the Capso menu-bar icon to edit all three bindings. Each recorder accepts a real modified key combination, validates that bindings are unique, and saves them to `~/Library/Application Support/com.capso.app/shortcut-settings.json`. A save first registers the complete candidate set and only then atomically replaces the JSON. Registration or storage failure rolls back to the previously active set; Capso reconciles partial OS rollback failures, keeps the tray capture actions available, and offers an unchanged retry. Global capture dispatch is suspended while the settings popover has focus so recording a binding cannot launch a picker.

The plugin is used entirely from Rust, so no global-shortcut commands are exposed to the webview and no frontend capability permission is enabled. The native result is emitted as an explicitly tagged `capture-finished` payload: top-level `captured`, `cancelled`, or `failed`. A clipboard failure remains top-level `captured` and carries its recoverable status under `clipboard`. Physical recording, relaunch persistence, any-foreground-app dispatch, real cross-app conflicts, rollback messaging, picker behavior, and general-pasteboard copy/paste still require manual QA before CAP-01 can pass.

## Menu lifecycle and macOS permissions

Capso is packaged as an agent app (`LSUIElement=true`), applies Tauri's Accessory activation policy, hides its popover on close, and remains available from the menu bar until **Quit Capso** is chosen. The bundle declares macOS 13 as its minimum because the Login Item control uses Apple's `SMAppService`.

Screen Recording status is checked without prompting at startup and whenever the popover regains focus. Region capture remains available in degraded mode. Window and fullscreen capture are blocked before `/usr/sbin/screencapture` can run, regardless of whether the request came from a shortcut, tray action, or direct Tauri command; a shortcut or tray attempt opens the visible guidance instead of saving blank pixels. The OS prompt only follows an explicit **Grant access** action and is attempted at most once per app session. A denied request becomes an **Open settings** action.

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
