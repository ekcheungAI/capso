const go = document.getElementById("go");
const last = document.getElementById("last");

chrome.storage.local.get("lastCapture").then(({ lastCapture }) => {
  if (lastCapture) {
    last.textContent = `Last: ${lastCapture.title}`;
  }
});

go.addEventListener("click", async () => {
  go.disabled = true;
  go.textContent = "Capturing…";
  const res = await chrome.runtime.sendMessage({ type: "capture" });
  if (res?.ok) {
    go.textContent = "Sent to Capso";
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
