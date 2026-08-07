# Capso Mac capture client

Tauri 2 menu-bar client for Capso's native screenshot workflow.

## Native capture command

The Rust backend exposes `capture_screen` with one argument:

```ts
type CaptureMode = "region" | "window" | "fullscreen";
```

Successful captures return:

```json
{ "status": "captured", "path": "…/com.capso.app/captures/<uuid>.png" }
```

Pressing Escape in an interactive picker returns `{ "status": "cancelled" }` and is not an error. Storage, launch, empty-output, and diagnostic failures reject with `{ "code", "message" }`.

Mode mapping:

- `region`: macOS interactive selection only.
- `window`: macOS interactive window selection only.
- `fullscreen`: main display capture. Multi-display selection is a later CAP-01 objective.

The command runs `/usr/sbin/screencapture` on Tauri's blocking executor and writes pixels into the application-data `captures/` directory before reporting success. Global shortcuts, clipboard output, overlay, upload queue, and background AI are deliberately separate objectives.

## Global capture entry points

Capso registers the three capture shortcuts from Rust at startup:

| Capture | Default | Tray fallback |
|---|---|---|
| Region | ⌃⇧C | Capture Region |
| Window | ⌃⇧W | Capture Window |
| Main-display fullscreen | ⌃⇧F | Capture Fullscreen |

Shortcut registration is isolated per action. If another app already owns one default, Capso keeps the other shortcuts active, identifies the unavailable shortcut in the tray menu and tooltip, and leaves every capture mode available from the menu. Shortcut presses trigger only once on the key-down event; a small process guard prevents overlapping native pickers.

Left-click the Capso menu-bar icon to edit all three bindings. Each recorder accepts a real modified key combination, validates that bindings are unique, and saves them to `~/Library/Application Support/com.capso.app/shortcut-settings.json`. A save first registers the complete candidate set and only then atomically replaces the JSON. Registration or storage failure rolls back to the previously active set; Capso reconciles partial OS rollback failures, keeps the tray capture actions available, and offers an unchanged retry. Global capture dispatch is suspended while the settings popover has focus so recording a binding cannot launch a picker.

The plugin is used entirely from Rust, so no global-shortcut commands are exposed to the webview and no frontend capability permission is enabled. The native result is emitted as `capture-finished` for the upcoming clipboard/overlay objective. Physical recording, relaunch persistence, any-foreground-app dispatch, real cross-app conflicts, rollback messaging, and picker behavior still require manual QA before CAP-01 can pass.

## Commands

```bash
pnpm --filter mac typecheck
pnpm --filter mac build
cargo test --manifest-path apps/mac/src-tauri/Cargo.toml
RUSTFLAGS='-D warnings' cargo check --manifest-path apps/mac/src-tauri/Cargo.toml --all-targets
```
