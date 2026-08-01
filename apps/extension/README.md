# Capso Chrome extension (MV3)

Captures the **visible browser tab** into your Capso memory. Browser tabs only — native app windows (Figma desktop, Xcode, Cursor, Simulator) still need the Mac app. That limit is the whole reason the extension complements rather than replaces it (decision D11).

## Download

`pnpm build:extension` zips this folder into `apps/web/public/`, then the running app serves it at **`/extension`** with the version, install steps and a download button.

## Install (unpacked, local only)

1. Start the web app: `pnpm dev:web` — the extension defaults to `http://localhost:3000`.
2. Open `chrome://extensions`, enable **Developer mode** (top right).
3. **Load unpacked** → select this folder (`apps/extension`).
4. Optional: `chrome://extensions/shortcuts` to change the hotkey. Default is **⌘⇧U** (macOS) / **Ctrl+Shift+U**.
5. To point at a deployment instead of localhost, open the extension's **Options** and save the address. Chrome asks for host access for that origin at save time.

## Use

- Press the hotkey, or click the toolbar icon and hit **Capture tab**.
- The capture appears in the open Capso tab within ~2.5s, runs through the same classification pass as drag/paste, and shows the usual overlay.
- Chrome refuses to capture `chrome://`, `edge://`, `about:` and Web Store pages. The extension says so rather than failing silently.

## How it reaches the app

The image is downscaled to ≤1600px JPEG **in the service worker** before it is sent. `captureVisibleTab` returns an uncompressed retina PNG — around 4 MB, or 5.5 MB once base64-encoded, which is over Vercel's 4.5 MB request limit. Compressing at the source is what makes the extension viable against a deployment at all.

A service worker cannot write to the web app's IndexedDB, so the extension POSTs to `/api/ingest` and the open Capso tab drains that queue. Captures are **held, not deleted, on read**: the app confirms each one once it is genuinely stored, and anything unconfirmed for 60s is offered again. A failure part-way through no longer destroys the rest of the batch. A full queue answers `507` rather than reporting success for a capture it threw away.

**Consequence worth knowing:** if no Capso tab is open, captures sit in the queue and are lost on server restart. The Mac app's on-disk queue is the durable path; this one is a bridge. Replacing it with direct Supabase writes is blocked on the web app moving off IndexedDB — see `specs/api_contracts.md` §Chrome extension.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest: `activeTab`, `storage`, `notifications`, optional host permissions, hotkey command |
| `background.js` | Service worker: `captureVisibleTab` → OffscreenCanvas compress → POST → notification |
| `popup.html` / `popup.js` | Toolbar popup with a capture button and the last capture |
| `options.html` / `options.js` | Where the Capso address is set; requests host access for it |
| `icons/` | 16/32/48/128 — Chrome needs all four, or the toolbar shows a generic tile |

## Updating

Chrome only auto-updates Web Store extensions and refuses `.crx` files served from a website unless the machine is under enterprise policy. So updates are: download the new zip, replace the contents of the **same folder**, press **Reload** on `chrome://extensions`. Keeping the path stable preserves the extension ID and your hotkey.

The background worker fetches `/extension-version.json` on startup and notifies once per version when your copy is behind. The popup shows the same nudge. That is the closest honest equivalent to auto-update without publishing.

## Not built yet

Region crop before sending (Chrome captures the whole viewport), full-page scrolling capture, annotation or blur before upload, capturing while the app is closed, and **any auth** — the endpoint identifies no user. That last one blocks direct-to-Supabase writes; the threat model is in `specs/permission_model.md` §Chrome extension.

**Never verified:** loading this in a real Chrome. The manifest and hotkey registration are unconfirmed.
