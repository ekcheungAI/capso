const field = document.getElementById("origin");
const device = document.getElementById("device");
const note = document.getElementById("note");
const save = document.getElementById("save");
const form = document.getElementById("settings");
let noteTimer = null;

const DEFAULT_ORIGIN = "http://localhost:3000";
/** Same shape the relay validates, so a bad paste is caught here rather than at capture time. */
const TOKEN = /^[A-Za-z0-9_-]{8,64}$/;

chrome.storage.local.get(["capsoOrigin", "capsoDevice"]).then(({ capsoOrigin, capsoDevice }) => {
  field.value = capsoOrigin || DEFAULT_ORIGIN;
  device.value = capsoDevice || "";
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

const fail = (message) => {
  note.textContent = message;
  note.className = "note error";
};

/** Returns a human reason this address will not work, or null if it will. */
async function probe(origin, token) {
  let res;
  try {
    res = await fetch(`${origin}/api/extension/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ check: true, deviceToken: token }),
    });
  } catch {
    return { problem: `Can't reach ${origin}. Is it running?` };
  }
  if (res.status === 401 || res.status === 403) {
    return { problem: "That code is not paired. Open Capso → Get extension, copy the code again, then Save." };
  }
  if (res.ok) return { mode: "direct" };
  if (res.status !== 404 && res.status !== 501) {
    return { problem: `That address answered ${res.status}.` };
  }

  // Old/local-only deployments have no direct account endpoint. Confirm the
  // legacy relay exists so existing installs stay usable during migration.
  try {
    const legacy = await fetch(`${origin}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ check: [] }),
    });
    if (legacy.ok) return { mode: "legacy" };
    if (legacy.status === 401 || legacy.status === 403) {
      return { problem: "That address asks for a login — use your public Capso address, not a protected preview." };
    }
    return { problem: legacy.status === 404 ? "That address doesn't look like Capso." : `That address answered ${legacy.status}.` };
  } catch {
    return { problem: `Can't reach ${origin}. Is it running?` };
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (save.disabled) return;
  save.disabled = true;
  if (noteTimer !== null) clearTimeout(noteTimer);
  noteTimer = null;

  try {
    let origin;
    try {
      const url = new URL(field.value.trim());
      if (!/^https?:$/.test(url.protocol)) throw new Error("protocol");
      // Store the origin only — a path here would produce //api/ingest later.
      origin = url.origin;
    } catch {
      return fail("That is not a valid http(s) address.");
    }

    const token = device.value.trim();
    if (!TOKEN.test(token)) {
      return fail("Paste the device code from Capso → Get extension.");
    }

    if (!(await ensurePermission(origin))) {
      return fail("Chrome needs permission for that address to send captures.");
    }

    // Probe before saving. A wrong address used to be discoverable only by taking
    // a capture and watching it not arrive — and the most likely wrong address is
    // a Vercel preview deployment, which answers 401 to everything and says
    // nothing about why.
    const result = await probe(origin, token);
    if (result.problem) return fail(result.problem);

    await chrome.storage.local.set({ capsoOrigin: origin, capsoDevice: token });
    field.value = origin;
    note.textContent = result.mode === "direct"
      ? "Paired — captures sync without an open Capso tab."
      : "Saved — this local build delivers when a Capso tab is open.";
    note.className = "note ok";

    // Anything queued while the extension was misconfigured can go now, rather
    // than waiting up to a minute for the next alarm.
    void chrome.runtime.sendMessage({ type: "drain" });

    noteTimer = setTimeout(() => {
      note.textContent = "";
      noteTimer = null;
    }, 2000);
  } catch {
    fail("Could not save these settings. Try again.");
  } finally {
    save.disabled = false;
  }
});
