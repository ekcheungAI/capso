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
