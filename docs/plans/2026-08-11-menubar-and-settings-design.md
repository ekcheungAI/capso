# Menu-bar restructure and Settings window — design

**Date:** 2026-08-11 · **Status:** approved by owner, ready to implement

## Problem

Running the app for the first time, the owner reported: the window could not be moved,
sign-in was impossible, and "the UI and UX is not good at all… it should be like CleanShot
where it just sits on the top bar until we need it."

The root issue is that one 360×720 popover does three unrelated jobs at once:

1. **Onboarding documentation** — a "Where to find them" table explaining that the timer
   lives in the tray menu and pinning lives in the capture preview.
2. **Status dashboard** — an "Area ready" pill and a permission banner.
3. **Settings editor** — shortcut rows with Change buttons.

That documentation table is the strongest signal: a UI that must explain where its own
features live has put them in the wrong place. CleanShot separates these concerns — the
menu-bar icon offers actions and then disappears; Settings is a distinct window opened rarely.

## What already exists (so this is a restructure, not a rewrite)

- The action menu is **already built** and wired: capture actions, Recent Captures
  submenu, Open Library, quit (`lib.rs` menu builder + `on_menu_event`).
- It is only reachable on **right**-click — `lib.rs` sets
  `.show_menu_on_left_click(false)`, and left-click toggles the popover instead.
- Sync is **already automatic** after login: `lib.rs:247` spawns a background sync on a
  successful auth callback, and again after every capture. The complaint "it should be
  synced after login" is a *copy* defect, not a behaviour gap — the header still reads
  "Captures stay local unless cloud sync is connected".

## Design

### 1. Menu-bar icon → one menu on either click

Left-click and right-click both open the same menu. The popover no longer opens from the
tray. Diagnostics appear only when they are actionable.

```
Capture Area                ⌃⇧C
Capture Window              ⌃⇧W
Capture Full Screen         ⌃⇧F
Capture Area in 5 Seconds
──────────────
Recent Captures            ▸
Open Library…
──────────────
⚠ Screen Recording needed…      (only when not granted)
Uploads waiting · Retry now     (only when the queue is non-empty)
──────────────
Settings…                   ⌘,
Quit Capso                  ⌘Q
```

### 2. The popover becomes a real Settings window

The `main` window is repurposed: wider, and given a **standard titlebar** instead of
`titleBarStyle: "Overlay"`. That makes it natively draggable and closable — fixing the
"can't move it" report at the root, rather than relying on a drag-region workaround.

Four tabs, matching CleanShot's icon-tab layout:

| Tab | Contents |
|---|---|
| **General** | Screen Recording status + Grant access; Launch at login toggle |
| **Shortcuts** | The three shortcut recorders; Restore defaults; Save |
| **Account** | Signed-in email; truthful sync state; Sign out |
| **Advanced** | Overlay Speed Check (p50/p90/max, PASS gate); upload queue + Retry now |

Diagnostics move to **Advanced** — still reachable, because Overlay Speed Check is the
evidence for the CAP-02b latency gate, but out of the daily path.

### 3. Deletions and copy fixes

- Delete the "Where to find them" table. The timer and Recent Captures are now visible
  menu items, so nothing needs explaining.
- Delete the in-popover Capture/Sync/System tab strip, replaced by real settings tabs.
- Header copy becomes state-dependent: signed out → "Sign in to sync captures to your
  library."; signed in → "Captures sync automatically."

## Non-goals

Scrolling capture, recording, GIF, OCR text-copy, and share links remain out of scope per
`27_CLEANSHOT_DAILY_DRIVER_PARITY.md`. This change is presentation only — no capture,
queue, auth, or upload logic is modified, so every existing Rust test stays valid.

## Verification

- `pnpm --filter mac typecheck`, mac frontend tests, `cargo test`, `pnpm verify`.
- Manual: left-click opens the menu; `Settings…` opens a window that drags by its
  titlebar; each tab renders; signed-in state shows the corrected sync copy.
