const go = document.getElementById("go");
const last = document.getElementById("last");
const dest = document.getElementById("dest");
const tabEl = document.getElementById("tab");

/**
 * Report the last capture, the destination, the current tab, and how many
 * captures are still waiting to reach Capso.
 *
 * Every one of those was invisible at some point, and each absence produced a
 * bug report that read "it doesn't do anything": the hotkey path reported only
 * through notifications (which macOS silences), the destination could be a dev
 * server that was not running, and the tab could be one Chrome refuses.
 */
async function refresh() {
  let status;
  try {
    status = await chrome.runtime.sendMessage({ type: "status" });
  } catch {
    dest.textContent = "unknown";
    return;
  }

  dest.textContent = status.origin ?? "not set";
  dest.className = "";

  if (status.pending > 0) {
    last.textContent = `${status.pending} waiting to reach Capso${
      status.lastResult && !status.lastResult.ok ? ` — ${status.lastResult.message}` : ""
    }`;
    last.className = "last";
  } else if (status.lastResult) {
    last.textContent = status.lastResult.message;
    last.className = status.lastResult.ok ? "last" : "last err";
  }

  // A queue that is not moving is almost always a wrong address, and the fix
  // lives on a page most people do not know exists. Shown only when something
  // is genuinely stuck, so it stays a fix rather than permanent chrome.
  document.getElementById("fix").hidden = status.pending === 0;

  // Opening the popup is the acknowledgement — the badge has done its job. It
  // comes straight back if anything is still queued.
  await chrome.action.setBadgeText({ text: status.pending > 0 ? String(status.pending) : "" });
}

document.getElementById("openOptions").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

void refresh();

// A capture may have been queued while the popup was closed; nudging the outbox
// on open means the count shown is the count after a real delivery attempt.
void chrome.runtime.sendMessage({ type: "drain" }).then(refresh).catch(() => {});

(async () => {
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
    go.textContent = res.pending > 0 ? "Saved — sending" : "Sent to Capso";
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
