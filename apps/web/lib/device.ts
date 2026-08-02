/**
 * This browser's identity for the capture relay.
 *
 * The relay hands a queued capture only to a poll carrying the same token. Until
 * this existed the queue was drain-once and unaddressed, so *any* open Capso tab
 * collected everything — including a second browser, or a verification tab
 * opened against the same deployment. A capture would simply arrive somewhere
 * the user was not looking, with nothing reporting it.
 *
 * Per browser profile, not per user: it is paired with one extension install,
 * and pairing a second browser is a deliberate act with its own code.
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
