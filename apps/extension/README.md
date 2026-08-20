# Capso Chrome extension (MV3)

Captures the **visible browser viewport, one visible DOM element, a selected area or the full scrollable page** into your Capso memory. Browser tabs only — native app windows (Figma desktop, Xcode, Cursor, Simulator) still need the Mac app. That limit is the whole reason the extension complements rather than replaces it (decision D11).

## Download

`pnpm build:extension` zips this folder into `apps/web/public/`, then the running app serves it at **`/extension`** with the version, install steps and a download button.

## Install (unpacked, local only)

1. Start the web app: `pnpm dev:web` — the extension defaults to `http://localhost:3000`.
2. Open `chrome://extensions`, enable **Developer mode** (top right).
3. **Load unpacked** → select this folder (`apps/extension`).
4. Optional: `chrome://extensions/shortcuts` to change the hotkey. Default is **⌘⇧U** (macOS) / **Ctrl+Shift+U**.
5. To point at a deployment instead of localhost, open the extension's **Options** and save the address. Chrome asks for host access for that origin at save time.

## Use

- Press the hotkey for the visible area, or open the toolbar popup and choose **Visible**, **Element**, **Area** or **Full**. Element mode highlights the smallest safe visible DOM box under the pointer; click to accept it, drag to fall back to a free area, or press Esc to cancel. Separate element/area/full-page commands are available at `chrome://extensions/shortcuts` if you want to assign keys.
- With a hosted account, the capture lands and starts classification even when every Capso tab is closed. Local-only development builds use the open-tab relay.
- Chrome refuses to capture `chrome://`, `edge://`, `about:` and Web Store pages. The extension says so rather than failing silently.

## How it reaches the app

Visible-area images are downscaled to ≤1600px JPEG **in the service worker** before they are sent. `captureVisibleTab` returns an uncompressed retina PNG — around 4 MB, or 5.5 MB once base64-encoded, which is over the request limit. Element and Area selectors are isolated in closed shadow roots, remove themselves for two animation frames before the Retina viewport is captured, then use one shared bounded crop/encode contract. Full-page capture uses temporary `activeTab` + `scripting` access after the user invokes it, performs at most two bounded warm-up passes so lazy-loaded height is measured before canvas allocation, and marks fixed/sticky content discovered during that warm-up for one-position capture. It then scrolls at Chrome's documented two-captures-per-second limit, draws each tile directly into a bounded ≤1600×12000 canvas, fails closed if document or viewport geometry drifts mid-capture, restores the original scroll position and every temporary attribute in all exit paths, and refuses pages above the 30-tile safety cap instead of silently truncating them. The final JPEG must fit below 2.25 MiB before it can enter the outbox.

The extension writes each capture to its own IndexedDB outbox before networking. It then calls `/api/extension/ingest`, which resolves the paired account, stores the JPEG/WebP objects and atomically creates the screenshot plus processing job. It deletes the local item only after Capso echoes the exact client-generated screenshot ID. Offline, browser restart, a lost response and an already-delivered retry all converge without losing or duplicating the capture.

Only deployments that answer `404/501` use the older `/api/ingest` relay. Auth failures and transient server failures stay queued; they never silently fall back to a second delivery path. The relay still requires an open Capso tab and exists only for deployment migration/local-only development.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest: `activeTab`, `scripting`, storage/notification permissions, optional delivery-host permissions and hotkey commands |
| `background.js` | Service worker: capture → durable outbox → status/notification |
| `outbox.js` / `delivery.js` | Exact-receipt direct delivery, retry and version-specific relay fallback |
| `popup.html` / `popup.js` / `popup-status.js` | Toolbar popup with four capture modes, project destination, relative delivery receipt, pending age and Retry now |
| `options.html` / `options.js` | Where the Capso address is set; requests host access for it |
| `icons/` | 16/32/48/128 — Chrome needs all four, or the toolbar shows a generic tile |

## Updating

Chrome only auto-updates Web Store extensions and refuses `.crx` files served from a website unless the machine is under enterprise policy. So updates are: download the new zip, replace the contents of the **same folder**, press **Reload** on `chrome://extensions`. Keeping the path stable preserves the extension ID and your hotkey.

The background worker fetches `/extension-version.json` on startup and notifies once per version when your copy is behind. The popup shows the same nudge. That is the closest honest equivalent to auto-update without publishing.

## Not built yet

Annotation or blur before upload, one-click pairing and a Web Store release. The popup can file directly to one of the paired account's active projects, and signed-in Web Settings can revoke the Chrome identity. Element/Area/full-page/project modes remain `UNVERIFIED` until an installed Chrome + hosted-account run covers element click/free-drag fallback/Escape, Retina crop accuracy, long pages, fixed/sticky content, dynamic loading, scroll restoration and explicit project filing. The manual code is authenticated and account-scoped, but still exposes infrastructure/setup detail that the final pairing journey should hide. The threat model is in `specs/permission_model.md` §Chrome extension.

**Never verified:** loading this in a real Chrome. The manifest and hotkey registration are unconfirmed.
