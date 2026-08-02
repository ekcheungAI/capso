import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * The browser's Supabase connection, and the anonymous session everything else
 * hangs off.
 *
 * Why anonymous sessions: every table's RLS policy is
 * `for all to authenticated using (user_id = auth.uid())` (migration 0001), and
 * Storage mirrors it on the first path segment (0002). A visitor therefore needs
 * a real `auth.users` row before they can read or write anything — but the demo
 * is deliberately open, so a login screen is not an option. `signInAnonymously()`
 * issues exactly that: a genuine authenticated identity, no credentials, no UI.
 * It also means the isolation guarantee is the same one that will protect real
 * accounts later, rather than a demo-only special case.
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
      // Load-bearing, not defaults-for-the-sake-of-it: without persistence every
      // reload mints a *new* anonymous user, and the library would look empty
      // each time. autoRefresh keeps a long-lived tab from silently 401ing.
      persistSession: true,
      autoRefreshToken: true,
    },
  });
  return client;
}

/** Distinguishes "the project has anonymous sign-ins turned off" from noise. */
export class AnonymousSignInDisabled extends Error {
  constructor(cause: string) {
    super(
      "Supabase rejected the anonymous sign-in. Enable it under " +
        `Authentication → Providers → Anonymous sign-ins. (${cause})`,
    );
    this.name = "AnonymousSignInDisabled";
  }
}

let pending: Promise<string> | null = null;

/**
 * The current user's id, signing in anonymously if there is no session yet.
 *
 * Every store write needs this: `user_id` is not defaulted server-side, and a row
 * written with the wrong one is invisible to its own author under RLS.
 *
 * Concurrent callers share one in-flight sign-in. Without that, the several
 * independent reads a first paint issues would each start their own, and
 * Supabase would hand back a different anonymous user to each.
 */
export function ensureSession(): Promise<string> {
  pending ??= (async () => {
    const sb = supabase();

    const { data: existing } = await sb.auth.getSession();
    if (existing.session?.user.id) return existing.session.user.id;

    const { data, error } = await sb.auth.signInAnonymously();
    if (error || !data.user) {
      pending = null; // let a later attempt retry rather than caching the failure
      throw new AnonymousSignInDisabled(error?.message ?? "no user returned");
    }
    return data.user.id;
  })();

  return pending;
}
