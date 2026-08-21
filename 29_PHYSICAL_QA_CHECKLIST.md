# 29 — Physical QA Checklist

> Hands-on QA for the CleanShot daily-driver gates that can only be proven by a human
> on real hardware. Run after `28_AI01_HOSTED_PROOF_RUNBOOK.md` passes. Targets come from
> `27_CLEANSHOT_DAILY_DRIVER_PARITY.md`; behavior labels/shortcuts match the shipped code.
>
> How to record: put a date + result (PASS / FAIL / N/A) and a note on each item. A gate
> is PASS only when every item under it passes. File any FAIL as a P0/P1 defect before the
> five-day dogfood (DOG-01) can start.

## Build and setup

- Build a debug bundle: `pnpm --filter mac tauri build --debug --bundles app`, or run
  `pnpm --filter mac tauri dev`.
- Grant **Screen Recording** when prompted (needed for Window and Fullscreen). System
  Settings → Privacy & Security → Screen Recording.
- Default shortcuts: **Region ⌘⇧4**, **Window ⌃⇧W**, **Fullscreen ⌃⇧F**.
- If macOS still owns **⌘⇧4**, disable its selected-area shortcut under System Settings
  → Keyboard → Keyboard Shortcuts → Screenshots before confirming the Capso binding.
- Run label: __________  Date: __________  macOS version: __________  Displays: __________

---

## CAP-02b — 20-capture perceived latency (the headline gate)

Target: **all 20** captures show the overlay in **under 1 second**; zero misses.

- [ ] Take 20 real captures across a normal work session (mix of region/window/fullscreen).
- [ ] Open the tray menu and read **"Overlay Speed Check"**. It must read **"PASS"**
      (not "19/20", "needs attention", or "unavailable").
- [ ] Record the exact readout: ________________________
- [ ] No capture felt visibly slow or dropped its overlay.

Result: ______  Note: __________________________________________

## UX-01 — menu-bar availability

- [ ] App shows a menu-bar item with **no Dock icon** and no app-switcher entry.
- [ ] Fresh launch does **not** enable launch-at-login; the login item is opt-in only.
- [ ] Toggle launch-at-login on, reboot, confirm it starts; toggle off, reboot, confirm it does not.
- [ ] Screen Recording permission flow appears when needed and links to the right pane.
- [ ] With Screen Recording off, choose **Continue with Area only**, quit, and relaunch:
      Area capture still works and Capso does not reopen permission guidance or show a
      global Screen Recording alert; Window and Full Screen remain clearly locked.
- [ ] On a fresh permission attempt, the first action says **Grant access**. Approve the
      macOS prompt and confirm Capso stays in its own window instead of opening System
      Settings; Window and Full Screen become ready.
- [ ] Stale-state recovery: when Capso says access is off although its System Settings
      toggle looks on, turn it off and on again, approve Touch ID, reopen Capso, and
      confirm the status changes to granted.
- [ ] Quit and relaunch from the menu bar; the popover reopens cleanly.

Result: ______  Note: __________________________________________

## CAP-01 — capture modes from any app

- [ ] With Screen Recording **off**, press **⌘⇧4**: the live desktop is immediately
      selectable with no white Capso frame or magnifier; releasing the mouse commits
      one PNG and shows Quick Access at bottom-right in under 1 second.
- [ ] From three different foreground apps, **⌘⇧4** starts region capture.
- [ ] **⌃⇧W** captures a window; **⌃⇧F** captures fullscreen.
- [ ] **Escape** cancels a capture silently (no error, no empty file, no overlay).
- [ ] Tray **Capture Region / Capture Window / Capture Fullscreen** work as fallbacks.
- [ ] Bind a conflicting shortcut and confirm the conflict message appears and the
      Capture menu still works ("shortcut conflict; Capture menu remains available").

Result: ______  Note: __________________________________________

## OVL-01 — overlay experience

- [ ] Overlay appears on the **same display** as the capture (test on a second monitor).
- [ ] Overlay **stays above** other windows and **never steals focus** (the app you were
      typing in keeps the cursor).
- [ ] Copy, Save, Annotate, drag-out, and Close all work from the overlay.
- [ ] Choose a fresh destination folder in Settings, take a capture, and click **Save**:
      no file dialog appears and one PNG with the configured naming format lands in that
      exact folder.
- [ ] Take another capture and click **Discard screenshot**: the preview closes, the
      capture is absent from Recent Captures, and previously saved files are untouched.
- [ ] Drag the thumbnail **out to Finder**; a PNG lands and the original is untouched.
- [ ] Mixed-scale test: capture on a Retina display and an external non-Retina display;
      the overlay is correctly sized on each.
- [ ] With no action, the overlay disappears about 10 seconds after its image appears.
- [ ] Restore a capture from **"Recent Captures"** in the tray.

Result: ______  Note: __________________________________________

## ANN-01 — annotation and irreversible redaction

- [ ] Arrow, box, and text tools each apply and render correctly.
- [ ] Blur/pixelate a region, save, then reopen the saved file — the redaction is
      **flattened into pixels** (cannot be peeled back).
- [ ] Copy an annotated capture and paste into another app: the pasted pixels are the
      **flattened** result.
- [ ] Download the same capture's cloud object from the web library and confirm its pixels
      are the flattened redaction (no original underneath).

Result: ______  Note: __________________________________________

## DUR-01b — durability offline drill (three captures)

- [ ] **Go offline** (Wi-Fi off). Take **3 captures**. Each is copyable immediately and the
      tray shows they are queued (originals stay local).
- [ ] **Quit and relaunch** the app while still offline. All 3 captures are still present
      and still queued — none lost, none duplicated.
- [ ] **Go back online.** Within ~5 seconds the queue drains and all 3 upload exactly once.
- [ ] Confirm in the web library that exactly 3 arrived, no duplicates.

Result: ______  Note: __________________________________________

## HIS-01 — reliable history

- [ ] The tray **"Recent Captures"** submenu shows the **eight** most recent, newest first.
- [ ] Relaunch the app; the eight recents survive with correct timestamps.
- [ ] Click a recent item and confirm it restores the **exact original pixels**.
- [ ] **"Open Library…"** opens the full web library.

Result: ______  Note: __________________________________________

---

## Sign-off

- [ ] Every gate above is PASS with notes recorded.
- [ ] AI-01 already PASS via `28_AI01_HOSTED_PROOF_RUNBOOK.md`.
- [ ] No open P0/P1 defects in capture, clipboard, overlay, durability, auth, processing,
      retrieval, permissions.

Remaining before cancelling CleanShot: RET-01/LRN-01 evals, PKG-01 (permanent bundle id +
Developer ID signing/notarization), then the DOG-01 five-day dogfood. Update the gate
scoreboard in `loops/STATE.md` as each gate here is signed off.
