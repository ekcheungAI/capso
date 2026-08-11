import "server-only";
import { createClient } from "@supabase/supabase-js";
import { verifyBearer, type BearerResult } from "@/lib/api/auth-guard";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** Verify the caller with Supabase Auth; never trust an Origin or body user id. */
export async function requireApiUser(request: Request): Promise<BearerResult> {
  if (!url || !anonKey) {
    return { ok: false, status: 503, error: "authentication unavailable" };
  }

  return verifyBearer(request.headers.get("authorization"), async (token) => {
    const client = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await client.auth.getUser(token);
    if (error || !data.user || data.user.is_anonymous) return null;
    return { id: data.user.id };
  });
}
