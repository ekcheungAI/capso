# Capso Chrome extension (MV3)

Captures the **visible browser tab** into your Capso memory. Browser tabs only — native app windows (Figma desktop, Xcode, Cursor, Simulator) still need the Mac app. That limit is the whole reason the extension complements rather than replaces it (decision D11).

## Download

`pnpm build:extension` zips this folder into `apps/web/public/`, then the running app serves it at **`/extension`** with the version, install steps and a download button.

## Install (unpacked, local only)

1. Start the web app: `pnpm dev:web` — the extension posts to `http://localhost:3000`.
2. Open `chrome://extensions`, enable **Developer mode** (top right).
3. **Load unpacked** → select this folder (`apps/extension`).
4. Optional: `chrome://extensions/shortcuts` to change the hotkey. Default is **⌘⇧U** (macOS) / **Ctrl+Shift+U**.

## Use

- Press the hotkey, or click the toolbar icon and hit **Capture tab**.
- The capture appears in the open Capso tab within ~2.5s, runs through the same classification pass as drag/paste, and shows the usual overlay.
- Chrome refuses to capture `chrome://`, `edge://`, `about:` and Web Store pages. The extension says so rather than failing silently.

## How it reaches the app

A service worker cannot write to the web app's IndexedDB, so the extension POSTs to `/api/ingest` and the open Capso tab drains that queue. The queue is in-memory and holds at most 20 captures — it survives seconds, not a server restart. When data moves to Supabase in P1 this becomes the real ingest endpoint from `specs/api_contracts.md` and the queue disappears.

**Consequence worth knowing:** if no Capso tab is open, captures sit in the queue and are lost on restart. The Mac app's on-disk queue is the durable path; this one is a demo bridge.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest: `activeTab`, `storage`, `notifications`, localhost host permission, hotkey command |
| `background.js` | Service worker: `chrome.tabs.captureVisibleTab` → POST → notification |
| `popup.html` / `popup.js` | Toolbar popup with a capture button and the last capture |

## Updating

Chrome only auto-updates Web Store extensions and refuses `.crx` files served from a website unless the machine is under enterprise policy. So updates are: download the new zip, replace the contents of the **same folder**, press **Reload** on `chrome://extensions`. Keeping the path stable preserves the extension ID and your hotkey.

The background worker fetches `/extension-version.json` on startup and notifies once per version when your copy is behind. The popup shows the same nudge. That is the closest honest equivalent to auto-update without publishing.

## Not built yet

Region crop before sending (Chrome captures the whole viewport), full-page scrolling capture, capturing while the app is closed, and any auth — the endpoint trusts localhost.
