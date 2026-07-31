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

chrome.commands.onCommand.addListener((command) => {
  if (command === "capture-tab") void captureActiveTab();
});

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.type === "capture") {
    captureActiveTab().then(respond);
    return true; // async response
  }
});
