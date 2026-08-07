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

## Commands

```bash
pnpm --filter mac typecheck
pnpm --filter mac build
cargo test --manifest-path apps/mac/src-tauri/Cargo.toml
RUSTFLAGS='-D warnings' cargo check --manifest-path apps/mac/src-tauri/Cargo.toml --all-targets
```
