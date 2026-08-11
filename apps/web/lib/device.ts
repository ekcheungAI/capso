/**
 * This browser's identity for the capture relay.
 *
 * The relay hands a queued capture only to a poll carrying the same token. Until
 * this existed the queue was drain-once and unaddressed, so *any* open Capso tab
 * collected everything — including a second browser, or a verification tab
 * opened against the same deployment. A capture would simply arrive somewhere
 * the user was not looking, with nothing reporting it.
 *
 * The stored value is per browser profile. Signed-in owners never expose it
 * directly: `accountDeviceToken` derives a separate code for each owner, so a
 * pending capture for one account cannot land after the browser switches to
 * another account.
 */
const KEY = "capso.device";
/** Matches the shape the relay validates — see api/ingest/route.ts. */
const TOKEN = /^[A-Za-z0-9_-]{8,64}$/;

export function deviceToken(): string {
  if (typeof window === "undefined") return "";
  const existing = window.localStorage.getItem(KEY);
  if (existing && TOKEN.test(existing)) return existing;

  const minted = `d_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  window.localStorage.setItem(KEY, minted);
  return minted;
}

/** Pure derivation used by both the app and its contract test. */
export async function deriveDeviceToken(browserToken: string, ownerId: string | null): Promise<string> {
  if (!ownerId) return browserToken;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${browserToken}:${ownerId}`),
  );
  const scoped = [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `d_${scoped}`;
}

/** The code the current extension pairing must use. */
export function accountDeviceToken(ownerId: string | null): Promise<string> {
  return deriveDeviceToken(deviceToken(), ownerId);
}
