/** Where the app lives when nothing has been configured. */
export const DEFAULT_ORIGIN = "http://localhost:3000";

/**
 * The configured app origin. Held in `chrome.storage` rather than hardcoded so
 * one build can point at localhost or a deployment — this used to be a `const`
 * in the service worker *and* a second copy in popup.js, so the extension only
 * ever worked against a local dev server.
 */
export async function origin() {
  const { capsoOrigin } = await chrome.storage.local.get("capsoOrigin");
  return (capsoOrigin || DEFAULT_ORIGIN).replace(/\/+$/, "");
}

/**
 * Which browser profile this extension delivers to.
 *
 * The relay hands a capture only to the poll carrying the same token, which is
 * what stops a second Capso tab in a second browser from collecting captures
 * meant for this one. Copied from the web app's `/extension` page at setup.
 */
export async function deviceToken() {
  const { capsoDevice } = await chrome.storage.local.get("capsoDevice");
  return capsoDevice || "";
}

/** Opaque ids for captures. Client-generated so a retry is idempotent. */
export function newId() {
  return `c_${Date.now().toString(36)}${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}
