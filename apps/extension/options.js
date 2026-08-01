const field = document.getElementById("origin");
const note = document.getElementById("note");
const save = document.getElementById("save");

const DEFAULT_ORIGIN = "http://localhost:3000";

chrome.storage.local.get("capsoOrigin").then(({ capsoOrigin }) => {
  field.value = capsoOrigin || DEFAULT_ORIGIN;
});

/**
 * Chrome grants host access per pattern, and the manifest cannot enumerate an
 * address the user has not chosen yet. Requesting it at save time is what lets
 * one build talk to localhost or a deployment without shipping a wildcard.
 */
async function ensurePermission(origin) {
  const pattern = `${origin}/*`;
  if (await chrome.permissions.contains({ origins: [pattern] })) return true;
  return chrome.permissions.request({ origins: [pattern] });
}

save.addEventListener("click", async () => {
  let origin;
  try {
    const url = new URL(field.value.trim());
    if (!/^https?:$/.test(url.protocol)) throw new Error("protocol");
    // Store the origin only — a path here would produce //api/ingest later.
    origin = url.origin;
  } catch {
    note.textContent = "That is not a valid http(s) address.";
    note.className = "note";
    return;
  }

  if (!(await ensurePermission(origin))) {
    note.textContent = "Chrome needs permission for that address to send captures.";
    note.className = "note";
    return;
  }

  await chrome.storage.local.set({ capsoOrigin: origin });
  field.value = origin;
  note.textContent = "Saved.";
  note.className = "note ok";
  setTimeout(() => {
    note.textContent = "";
  }, 2000);
});
