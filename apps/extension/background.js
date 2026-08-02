/**
 * Capso capture path for browser tabs.
 *
 * Captures the visible tab, compresses it here, and hands it to the outbox,
 * which owns delivery. Browser tabs only — native app windows (Figma desktop,
 * Xcode, Cursor) still need the Mac app. See D11.
 *
 * The capture path deliberately ends at `enqueue`: once a capture is in
 * IndexedDB it cannot be lost by a failed request, a closed tab, a recycled
 * serverless instance or a browser restart. Everything after that is retry.
 */

import { origin } from "./config.js";
import { captureVisibleTab } from "./capture.js";
import { ALARM, count, drain, enqueue } from "./outbox.js";

async function capture() {
  const shot = await captureVisibleTab();
  if (!shot.ok) return fail(shot.message);

  await enqueue(shot.capture);
  // Report on the capture, not on the delivery. The image is safe either way,
  // and blocking the report on a network round-trip is what made a working
  // capture and a failed one look identical.
  const result = await drain();

  const pending = result.pending;
  if (pending === 0) {
    await record(true, `Sent “${shot.label}” to Capso.`);
    notify("Sent to Capso", shot.label);
  } else {
    await record(true, `Saved. ${pending} waiting to reach Capso — ${result.lastError ?? "retrying"}`);
  }
  return { ok: true, pending };
}

function fail(message) {
  void record(false, message);
  notify("Capture failed", message);
  return { ok: false, message };
}

/**
 * Feedback that survives the OS.
 *
 * The hotkey path had exactly one way to report anything — `chrome.notifications`
 * — and macOS suppresses those entirely unless Chrome is allowed to notify in
 * System Settings. With them off, a capture that worked and a capture that
 * failed were both silence, from a path where the popup is not open to show
 * anything. The badge needs no permission and cannot be silenced.
 */
async function record(ok, message) {
  await chrome.storage.local.set({
    lastResult: { ok, message, at: new Date().toISOString() },
  });
  await badge(ok);
}

/**
 * A count beats a glyph: "3" says captures are waiting and roughly how badly,
 * where "!" said only that something, once, went wrong.
 *
 * Text only, no background colour — a service worker cannot read the CSS custom
 * properties the rest of the extension is styled from, and hardcoding a hex here
 * is what `pnpm brand:check` exists to stop.
 */
async function badge(ok = true) {
  try {
    const pending = await count();
    await chrome.action.setBadgeText({ text: pending > 0 ? String(pending) : ok ? "" : "!" });
  } catch {
    // Badge is a nicety; never let it fail a capture that otherwise worked.
  }
}

function notify(title, message) {
  chrome.notifications.create({
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
  const base = await origin();
  try {
    const res = await fetch(`${base}/extension-version.json`, { cache: "no-store" });
    if (!res.ok) return;
    const { version } = await res.json();
    const mine = chrome.runtime.getManifest().version;
    if (!version || compare(version, mine) <= 0) return;

    const { updateNotified } = await chrome.storage.local.get("updateNotified");
    if (updateNotified === version) return;

    await chrome.storage.local.set({ updateNotified: version });
    notify(`Capso ${version} available`, `You are on ${mine}. Download it at ${base}/extension`);
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

/** Retry is alarm-driven because a worker holding a `setTimeout` is a worker that has been killed. */
async function startup() {
  await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  await drain();
  await badge();
  await checkForUpdate();
}

chrome.runtime.onStartup.addListener(() => void startup());
chrome.runtime.onInstalled.addListener(() => void startup());

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM) return;
  void drain().then(() => badge());
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "capture-tab") void capture();
});

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.type === "capture") {
    capture().then(respond);
    return true; // async response
  }
  if (msg?.type === "getOrigin") {
    origin().then((base) => respond({ origin: base }));
    return true;
  }
  if (msg?.type === "status") {
    (async () => {
      const { lastResult } = await chrome.storage.local.get("lastResult");
      respond({ origin: await origin(), pending: await count(), lastResult: lastResult ?? null });
    })();
    return true;
  }
  if (msg?.type === "drain") {
    drain().then(async (r) => {
      await badge();
      respond(r);
    });
    return true;
  }
  // An unhandled type used to close the port silently, so the popup's awaited
  // sendMessage resolved undefined and reported a bare "Failed."
  respond({ ok: false, message: `Unknown message type: ${msg?.type}` });
  return false;
});
