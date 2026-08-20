import { deviceToken, newId, origin } from "./config.js";
import { thumbnail } from "./capture.js";
import { directDeliveryOutcome } from "./delivery.js";

/**
 * The durable half of the capture path.
 *
 * The relay on the server is a module-scope array: per-instance on serverless,
 * gone on recycle. Rather than make *that* durable, the capture lives here until
 * the web app confirms it stored it. A lost relay costs a re-send; it cannot
 * cost a capture. This is also why the ids are generated here — a retry has to
 * carry the same id or it becomes a second capsule.
 *
 * IndexedDB rather than `chrome.storage.local`: the latter is 10 MB, stores JSON
 * only, and therefore holds base64 at a 33% inflation — roughly 15 queued
 * captures before hard failure. IDB stores Blobs natively and, with
 * `unlimitedStorage`, has no practical ceiling.
 */

const DB = "capso-outbox";
const STORE = "pending";
/** MV3 workers die after ~30s idle, so retries are alarm-driven, not timer-driven. */
export const ALARM = "capso-drain";
/** Give up reporting after this, but never silently delete. */
const MAX_ATTEMPTS = 50;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const store = db.transaction(STORE, mode).objectStore(STORE);
      const req = fn(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export const all = () => tx("readonly", (s) => s.getAll());
export const count = () => tx("readonly", (s) => s.count());
const put = (item) => tx("readwrite", (s) => s.put(item));
const drop = (id) => tx("readwrite", (s) => s.delete(id));

/** Accept a capture into the outbox. It is safe from this moment. */
export async function enqueue(capture) {
  const item = { id: newId(), capture, at: new Date().toISOString(), attempts: 0, lastError: null };
  await put(item);
  return item;
}

/**
 * Push everything pending. A direct account delivery retires only after the
 * server echoes the exact screenshot id. Deployments without that endpoint use
 * the older open-tab relay until they are upgraded.
 */
export async function drain() {
  const items = await all();
  if (items.length === 0) return { sent: 0, pending: 0, lastError: null };

  const base = await origin();
  const device = await deviceToken();
  if (!device) {
    return { sent: 0, pending: items.length, lastError: "Not paired — set the device code in Options." };
  }

  let sent = 0;
  let lastError = null;
  let usedLegacy = false;

  for (const item of items) {
    try {
      const upgradedCapture = item.capture.thumbDataUrl
        ? item.capture
        : { ...item.capture, thumbDataUrl: await thumbnail(item.capture.imageDataUrl) };
      const direct = await fetch(`${base}/api/extension/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: item.id,
          deviceToken: device,
          capturedAt: item.at,
          ...upgradedCapture,
        }),
      });
      const directBody = await direct.json().catch(() => null);
      const outcome = directDeliveryOutcome(direct.status, directBody, item.id);

      if (outcome.kind === "delivered") {
        await drop(item.id);
        sent++;
        continue;
      }
      if (outcome.kind === "unpaired") {
        lastError = "This device code is not paired — open Capso → Get extension, then save it again.";
        await put({ ...item, capture: upgradedCapture, attempts: item.attempts + 1, lastError });
        continue;
      }
      if (outcome.kind === "retry") {
        lastError = outcome.message;
        await put({ ...item, capture: upgradedCapture, attempts: item.attempts + 1, lastError });
        continue;
      }

      usedLegacy = true;
      const res = await fetch(`${base}/api/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: item.id, deviceToken: device, ...upgradedCapture }),
      });

      if (res.status === 507) {
        // Backpressure, not failure. The relay is full because nothing is
        // draining it; the capture is still here and will go on the next pass.
        lastError = "Capso's relay is full — open Capso to take them.";
        await put({ ...item, attempts: item.attempts + 1, lastError });
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        // A Vercel preview deployment answers 401 "Protected deployment" to
        // everything, including this. Naming it beats "Capso responded 401",
        // because the fix is an address change and nothing about a 401 says so.
        lastError = `${base} is asking for a login — use your public Capso address, not a protected preview.`;
        await put({ ...item, attempts: item.attempts + 1, lastError });
        continue;
      }
      if (!res.ok) {
        lastError = `Capso responded ${res.status}.`;
        await put({ ...item, attempts: item.attempts + 1, lastError });
        continue;
      }

      sent++;
      await put({ ...item, capture: upgradedCapture, attempts: item.attempts + 1, lastError: null });
    } catch {
      lastError = `Capso isn't reachable at ${base}.`;
      await put({ ...item, attempts: item.attempts + 1, lastError });
    }
  }

  if (usedLegacy) await retireConfirmed(base);
  return { sent, pending: await count(), lastError };
}

/**
 * Ask which ids the web app has actually stored, and drop only those.
 *
 * A cheap check rather than re-uploading to find out: without it the only way to
 * learn a capture landed would be to send its bytes a second time.
 */
async function retireConfirmed(base) {
  const items = await all();
  if (items.length === 0) return;
  try {
    const res = await fetch(`${base}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ check: items.map((i) => i.id) }),
    });
    if (!res.ok) return;
    const { confirmed } = await res.json();
    for (const id of confirmed ?? []) await drop(id);
  } catch {
    // Offline. Everything stays queued, which is the correct outcome.
  }
}

/** Items that have been retried past the point of usefulness still exist — they are just loud. */
export async function stuck() {
  return (await all()).filter((i) => i.attempts >= MAX_ATTEMPTS);
}
