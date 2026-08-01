/**
 * Capso capture path for browser tabs.
 *
 * Captures the visible tab, compresses it here, and posts it to the Capso app,
 * which queues it for the same ingest pipeline drag/paste uses. Browser tabs
 * only — native app windows (Figma desktop, Xcode, Cursor) still need the Mac
 * app. See D11.
 */

/** Where the app lives when nothing has been configured. */
const DEFAULT_ORIGIN = "http://localhost:3000";

/** Long edge of the stored original; matches the web app's own ingest cap. */
const MAX_EDGE = 1600;
/** JPEG quality for that original. */
const FULL_QUALITY = 0.85;

/**
 * The configured app origin. Held in `chrome.storage` rather than hardcoded so
 * one build can point at localhost or a deployment — this used to be a `const`
 * in this file *and* a second copy in popup.js, so the extension only ever
 * worked against a local dev server.
 */
async function origin() {
  const { capsoOrigin } = await chrome.storage.local.get("capsoOrigin");
  return (capsoOrigin || DEFAULT_ORIGIN).replace(/\/+$/, "");
}

/**
 * Shrink and re-encode before it ever reaches the wire.
 *
 * `captureVisibleTab` returns an uncompressed retina PNG — measured at ~4.2 MB,
 * which is ~5.6 MB once base64-encoded and therefore over Vercel's 4.5 MB
 * request-body limit. The app used to do this downscale *after* receiving the
 * image, which is too late to help. `OffscreenCanvas` is available in an MV3
 * service worker; note `convertToBlob`, since workers have no `toDataURL`.
 */
async function compress(dataUrl) {
  const source = await createImageBitmap(await (await fetch(dataUrl)).blob());
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(source.width, source.height));
    const w = Math.max(1, Math.round(source.width * scale));
    const h = Math.max(1, Math.round(source.height * scale));

    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext("2d").drawImage(source, 0, 0, w, h);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: FULL_QUALITY });

    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } finally {
    source.close();
  }
}

async function captureActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return fail("No active tab.");

  // chrome:// and the Web Store are off-limits to captureVisibleTab by policy.
  if (!tab.url || /^(chrome|edge|about|devtools|view-source):/i.test(tab.url)) {
    return fail("Chrome blocks capture on this page.");
  }

  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab({ format: "png" });
  } catch (err) {
    return fail(err?.message ?? "Capture failed.");
  }

  try {
    dataUrl = await compress(dataUrl);
  } catch {
    // Better a large capture than none — the app downscales again on receipt.
  }

  const base = await origin();
  let res;
  try {
    res = await fetch(`${base}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        imageDataUrl: dataUrl,
        source: "extension",
        pageUrl: tab.url,
        pageTitle: tab.title ?? "",
      }),
    });
  } catch {
    return fail(`Capso isn't reachable at ${base}.`);
  }

  // Distinguish the failures instead of blaming the server for all of them.
  // Every non-OK response used to read "Capso isn't running".
  if (res.status === 507) return fail("Capso's queue is full — open the app to take them.");
  if (!res.ok) return fail(`Capso responded ${res.status}.`);

  const stamp = new Date().toISOString();
  await chrome.storage.local.set({ lastCapture: { title: tab.title ?? tab.url, at: stamp } });
  notify("Sent to Capso", tab.title ?? tab.url);
  return { ok: true };
}

function fail(message) {
  notify("Capture failed", message);
  return { ok: false, message };
}

function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title,
    message: String(message).slice(0, 120),
  });
}

/**
 * Chrome only auto-updates Web Store extensions, so a self-hosted copy has to
 * notice on its own. Compare our manifest version against the one the app
 * publishes and tell the user once per version, not on every startup.
 */
async function checkForUpdate() {
  const base = await origin();
  try {
    const res = await fetch(`${base}/extension-version.json`, { cache: "no-store" });
    if (!res.ok) return;
    const { version } = await res.json();
    const mine = chrome.runtime.getManifest().version;
    if (!version || compare(version, mine) <= 0) return;

    const { updateNotified } = await chrome.storage.local.get("updateNotified");
    if (updateNotified === version) return;

    await chrome.storage.local.set({ updateNotified: version });
    notify(`Capso ${version} available`, `You are on ${mine}. Download it at ${base}/extension`);
  } catch {
    // app not running — nothing to check against
  }
}

/** Numeric semver-ish compare; returns >0 when a is newer than b. */
function compare(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

chrome.runtime.onStartup.addListener(() => void checkForUpdate());
chrome.runtime.onInstalled.addListener(() => void checkForUpdate());

chrome.commands.onCommand.addListener((command) => {
  if (command === "capture-tab") void captureActiveTab();
});

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.type === "capture") {
    captureActiveTab().then(respond);
    return true; // async response
  }
  if (msg?.type === "getOrigin") {
    origin().then((base) => respond({ origin: base }));
    return true;
  }
  // An unhandled type used to close the port silently, so the popup's awaited
  // sendMessage resolved undefined and reported a bare "Failed."
  respond({ ok: false, message: `Unknown message type: ${msg?.type}` });
  return false;
});
