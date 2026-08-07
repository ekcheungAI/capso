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

The bundled window is hidden by default, undecorated, non-focusable, always on top, visible across workspaces, and excluded from task surfaces by the menu-bar-only app lifecycle. OVL-01a is click-through so its display-only thumbnail cannot block the foreground app; OVL-01b will enable pointer interaction when it adds controls. Its asset protocol can read only `$APPDATA/captures/**`, and its separate capability grants only Tauri event access. Clipboard or overlay delivery failures remain nested post-capture statuses and never downgrade the stored pixels.

OVL-01a has automated placement/configuration/ordering/failure proof and light/dark visual evidence. Native focus preservation, real two-display placement with mixed scale factors, and perceived appearance latency remain manual QA. Copy, Save, Annotate, drag-out, Close, auto-dismiss, and history restore belong to OVL-01b and are not claimed here.

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
