const go = document.getElementById("go");
const last = document.getElementById("last");
const dest = document.getElementById("dest");
const tabEl = document.getElementById("tab");

/**
 * Report the last capture, including one made by the hotkey while this popup was
 * closed. That path used to report only through `chrome.notifications`, so with
 * macOS notifications off for Chrome it had no way to tell the user anything at
 * all — success and failure were both silence.
 */
chrome.storage.local.get(["lastResult", "lastCapture"]).then(({ lastResult, lastCapture }) => {
  if (lastResult) {
    last.textContent = lastResult.message;
    last.className = lastResult.ok ? "last" : "last err";
  } else if (lastCapture) {
    last.textContent = `Last: ${lastCapture.title}`;
  }
  // Opening the popup is the acknowledgement — the badge has done its job.
  void chrome.action.setBadgeText({ text: "" });
});

/** Where captures are being sent, and what this tab actually is. */
(async () => {
  try {
    const { origin } = await chrome.runtime.sendMessage({ type: "getOrigin" });
    dest.textContent = origin ?? "not set";
    dest.className = "";
  } catch {
    dest.textContent = "unknown";
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) {
    // Not a failure in itself — Chrome withholds the address until activeTab is
    // granted — but it is worth saying rather than showing a blank line.
    tabEl.textContent = "address not shared by Chrome";
    return;
  }
  tabEl.textContent = tab.url.replace(/^https?:\/\//, "").slice(0, 60);
  tabEl.className = "";
})();

go.addEventListener("click", async () => {
  go.disabled = true;
  go.textContent = "Capturing…";
  const res = await chrome.runtime.sendMessage({ type: "capture" });
  if (res?.ok) {
    go.textContent = "Sent to Capso";
    void chrome.action.setBadgeText({ text: "" });
    setTimeout(() => window.close(), 700);
  } else {
    go.disabled = false;
    go.textContent = "Capture tab";
    last.textContent = res?.message ?? "Failed.";
    last.className = "last err";
  }
});

/** Newer-than compare. `!==` used to flag a *newer* local build as outdated. */
function isNewer(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

// Nudge toward the download page when the hosted build is newer. The origin
// comes from the background rather than a second hardcoded literal.
(async () => {
  try {
    const { origin } = await chrome.runtime.sendMessage({ type: "getOrigin" });
    if (!origin) return;
    const res = await fetch(`${origin}/extension-version.json`, { cache: "no-store" });
    if (!res.ok) return;
    const { version } = await res.json();
    if (!version || !isNewer(version, chrome.runtime.getManifest().version)) return;

    last.textContent = `Update available: v${version} — `;
    const link = document.createElement("a");
    link.href = `${origin}/extension`;
    link.target = "_blank";
    link.textContent = "download";
    // Built as a node rather than innerHTML: `origin` is user-configurable, and
    // interpolating it into markup would make the options page an XSS vector.
    last.appendChild(link);
  } catch {
    // app not running — nothing to check against
  }
})();
