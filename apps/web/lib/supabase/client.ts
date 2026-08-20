import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { bearerHeaders } from "@/lib/api/auth-guard";
import { loadPermanentAccount, permanentAccountFromSession, requirePermanentUserId } from "./account";

/**
 * The browser's one Supabase connection. Its persisted session is also the
 * identity that owns every Postgres row and Storage object in the library.
 */

// Read as literals. `NEXT_PUBLIC_*` values are inlined at build time, so a
// dynamic lookup like process.env[name] resolves to undefined in the browser.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/**
 * Whether this deployment has a backend at all.
 *
 * The store falls back to IndexedDB when it does not, mirroring how `classify.ts`
 * falls back to simulated output without an API key: a missing environment
 * variable should degrade the app, never blank it. It also keeps `pnpm dev` in a
 * fresh clone working with no setup.
 */
export function isConfigured(): boolean {
  return Boolean(url && anonKey);
}

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (!isConfigured()) {
    throw new Error("Supabase is not configured — call isConfigured() first.");
  }
  // Created once. A second client would keep its own session and auth listener,
  // and the two would race over the same storage key on refresh.
  client ??= createClient(url!, anonKey!, {
    auth: {
      // Persistence makes the emailed login survive reloads. autoRefresh keeps
      // a long-lived library from silently losing its authenticated requests.
      persistSession: true,
      autoRefreshToken: true,
    },
  });
  return client;
}

/**
 * Return the durable email account id or fail visibly before the store opens.
 * Every write sets this id explicitly because `user_id` has no database default.
 */
export async function requireSession(): Promise<string> {
  return requirePermanentUserId(await loadPermanentAccount(supabase().auth));
}

/**
 * Call a same-origin account API with the current access token. In an entirely
 * unconfigured local build the request still reaches the route so its normal
 * demo-mode 503 behavior remains available.
 */
export async function accountFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  if (!isConfigured()) return fetch(input, init);
  if (
    process.env.NODE_ENV !== "production" &&
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("preview") === "devices"
  ) {
    return fetch(input, init);
  }

  const { data, error } = await supabase().auth.getSession();
  const account = permanentAccountFromSession(data.session);
  if (error || account.status !== "signed_in" || !data.session?.access_token) {
    throw new Error("Sign in to use Capso AI.");
  }

  return fetch(input, {
    ...init,
    headers: bearerHeaders(init.headers, data.session.access_token),
  });
}
