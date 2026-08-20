import { createClient } from "@supabase/supabase-js";
import { isSameOrigin } from "@/lib/api/auth-guard";
import { EXTENSION_DEVICE_TOKEN, extensionDeviceHash } from "@/lib/extension-device";
import { requireApiUser } from "@/lib/supabase/server-auth";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export async function PUT(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "forbidden" }, { status: 403 });
  const auth = await requireApiUser(request);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (!url || !anonKey) return Response.json({ error: "pairing unavailable" }, { status: 503 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const token = body && typeof body === "object" && "deviceToken" in body
    ? (body as { deviceToken?: unknown }).deviceToken
    : null;
  if (typeof token !== "string" || !EXTENSION_DEVICE_TOKEN.test(token)) {
    return Response.json({ error: "invalid device code" }, { status: 400 });
  }

  const client = createClient(url, anonKey, {
    global: { headers: { authorization: `Bearer ${auth.token}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { error } = await client.from("extension_devices").upsert({
    user_id: auth.userId,
    token_hash: await extensionDeviceHash(token),
    label: "Chrome extension",
    revoked_at: null,
  }, { onConflict: "token_hash" });
  if (error) return Response.json({ error: "device could not be paired" }, { status: 502 });
  return Response.json({ paired: true });
}
