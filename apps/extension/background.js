/**
 * Capso capture path for browser tabs.
 *
 * Captures the visible tab and posts it to the local Capso app, which queues it
 * for the same ingest pipeline drag/paste uses. Browser tabs only — native app
 * windows (Figma desktop, Xcode, Cursor) still need the Mac app. See D11.
 */

const CAPSO_ORIGIN = "http://localhost:3000";

async function captureActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return fail("No active tab.");

  // chrome:// and the Web Store are off-limits to captureVisibleTab by policy.
  if (!tab.url || /^(chrome|edge|about|devtools):/i.test(tab.url)) {
    return fail("Chrome blocks capture on this page.");
  }

  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab({ format: "png" });
  } catch (err) {
    return fail(err?.message ?? "Capture failed.");
  }

  try {
    const res = await fetch(`${CAPSO_ORIGIN}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        imageDataUrl: dataUrl,
        source: "extension",
        pageUrl: tab.url,
        pageTitle: tab.title ?? "",
      }),
    });
    if (!res.ok) throw new Error(`Capso responded ${res.status}`);
  } catch {
    return fail("Capso isn't running at localhost:3000.");
  }

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
  chrome.notifications?.create({
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
  try {
    const res = await fetch(`${CAPSO_ORIGIN}/extension-version.json`, { cache: "no-store" });
    if (!res.ok) return;
    const { version } = await res.json();
    const mine = chrome.runtime.getManifest().version;
    if (!version || version === mine) return;
    if (compare(version, mine) <= 0) return;

    const { updateNotified } = await chrome.storage.local.get("updateNotified");
    if (updateNotified === version) return;

    await chrome.storage.local.set({ updateNotified: version });
    notify(`Capso ${version} available`, `You are on ${mine}. Download it at ${CAPSO_ORIGIN}/extension`);
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
});
