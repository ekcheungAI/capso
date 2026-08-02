// Geometry and encoding come from the one shared spec, mirrored here by
// `pnpm capture:spec` because this extension has no bundler. These used to be
// two local constants whose only tie to the web app's was a comment saying they
// matched — see packages/shared/src/capture.ts.
import { FULL_QUALITY, FULL_TYPE, fitWithin } from "./capture-spec.generated.js";

export { contentHash } from "./capture-spec.generated.js";

/**
 * Shrink and re-encode before it ever reaches the wire.
 *
 * `captureVisibleTab` returns an uncompressed retina PNG — measured at ~4.2 MB,
 * which is ~5.6 MB once base64-encoded and therefore over Vercel's 4.5 MB
 * request-body limit. `OffscreenCanvas` is available in an MV3 service worker;
 * note `convertToBlob`, since workers have no `toDataURL`.
 *
 * Returns the encoded data URL *and* its true pixel size, because the web app
 * uses width/height to reserve layout before the image decodes and had been
 * receiving null for every extension capture.
 */
export async function compress(dataUrl) {
  const source = await createImageBitmap(await (await fetch(dataUrl)).blob());
  try {
    const { width: w, height: h } = fitWithin(source.width, source.height);

    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext("2d").drawImage(source, 0, 0, w, h);
    const blob = await canvas.convertToBlob({ type: FULL_TYPE, quality: FULL_QUALITY });

    const encoded = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    return { dataUrl: encoded, width: w, height: h };
  } finally {
    source.close();
  }
}

/** Schemes `captureVisibleTab` refuses by policy — there is nothing to attempt there. */
const BLOCKED = ["chrome", "edge", "about", "devtools", "view-source", "chrome-extension"];

/**
 * Grab the visible viewport of the active tab.
 *
 * Returns `{ ok: false, message }` rather than throwing, so every caller reports
 * the same way. A tab whose URL cannot be read is *not* refused — that means
 * activeTab has not been granted yet, not that capture is blocked, and Chrome's
 * own error is more accurate than our guess.
 */
export async function captureVisibleTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { ok: false, message: "No active tab." };

  const scheme = tab.url?.match(/^([a-z-]+):/i)?.[1]?.toLowerCase();
  if (scheme && BLOCKED.includes(scheme)) {
    return {
      ok: false,
      message: `Chrome won't allow capture on ${scheme}: pages. Switch to an ordinary tab and try again.`,
    };
  }

  let raw;
  try {
    raw = await chrome.tabs.captureVisibleTab({ format: "png" });
  } catch (err) {
    return { ok: false, message: err?.message ?? "Capture failed." };
  }

  // A compress failure used to fall through and post the raw ~5.5 MB base64 PNG
  // with a comment saying the app would downscale it on receipt. It cannot: that
  // body is over Vercel's limit and the request never lands. Failing here keeps
  // the capture recoverable instead of sending something guaranteed to be lost.
  let shrunk;
  try {
    shrunk = await compress(raw);
  } catch (err) {
    return { ok: false, message: `Could not encode the capture (${err?.message ?? "unknown"}).` };
  }

  let host;
  try {
    host = tab.url ? new URL(tab.url).hostname : undefined;
  } catch {
    host = undefined;
  }

  return {
    ok: true,
    capture: {
      imageDataUrl: shrunk.dataUrl,
      width: shrunk.width,
      height: shrunk.height,
      contentHash: await contentHash(shrunk.dataUrl),
      source: "extension",
      pageUrl: tab.url,
      pageTitle: tab.title ?? "",
      // The column has existed since loop 03 and was never written by anything,
      // so "the screenshot from Notion" had no data to match against.
      sourceApp: host,
    },
    label: tab.title || tab.url || "Capture",
  };
}
