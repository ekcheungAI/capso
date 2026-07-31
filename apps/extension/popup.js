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

// Nudge toward the download page when the hosted build is newer.
fetch("http://localhost:3000/extension-version.json", { cache: "no-store" })
  .then((r) => (r.ok ? r.json() : null))
  .then((info) => {
    if (!info) return;
    const mine = chrome.runtime.getManifest().version;
    if (info.version !== mine) {
      last.innerHTML =
        'Update available: v' + info.version +
        ' — <a href="http://localhost:3000/extension" target="_blank">download</a>';
    }
  })
  .catch(() => {});
