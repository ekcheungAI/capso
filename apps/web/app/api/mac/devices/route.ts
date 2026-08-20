import { createClient } from "@supabase/supabase-js";
import { isSameOrigin } from "@/lib/api/auth-guard";
import { MAC_DEVICE_ID } from "@/lib/mac-device";
import { requireApiUser } from "@/lib/supabase/server-auth";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

async function accountClient(request: Request) {
  const auth = await requireApiUser(request);
  if (!auth.ok) return auth;
  if (!url || !anonKey) {
    return { ok: false as const, status: 503 as const, error: "device management unavailable" };
  }
  return {
    ok: true as const,
    userId: auth.userId,
    client: createClient(url, anonKey, {
      global: { headers: { authorization: `Bearer ${auth.token}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  };
}

export async function GET(request: Request) {
  const account = await accountClient(request);
  if (!account.ok) return Response.json({ error: account.error }, { status: account.status });
  const { data, error } = await account.client
    .from("mac_devices")
    .select("id,label,platform,app_version,created_at,last_seen_at,last_capture_at")
    .eq("user_id", account.userId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });
  if (error) return Response.json({ error: "Mac devices could not be loaded" }, { status: 502 });
  return Response.json({
    devices: (data ?? []).map((device) => ({
      id: device.id,
      label: device.label,
      platform: device.platform,
      appVersion: device.app_version,
      createdAt: device.created_at,
      lastSeenAt: device.last_seen_at,
      lastCaptureAt: device.last_capture_at,
    })),
  });
}

export async function DELETE(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "forbidden" }, { status: 403 });
  const account = await accountClient(request);
  if (!account.ok) return Response.json({ error: account.error }, { status: account.status });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const id = body && typeof body === "object" && "id" in body
    ? (body as { id?: unknown }).id
    : null;
  if (typeof id !== "string" || !MAC_DEVICE_ID.test(id)) {
    return Response.json({ error: "invalid device id" }, { status: 400 });
  }
  const { data, error } = await account.client.rpc("revoke_mac_device", { p_device_id: id });
  if (error) return Response.json({ error: "Mac device could not be disconnected" }, { status: 502 });
  if (data !== true) return Response.json({ error: "device not found" }, { status: 404 });
  return Response.json({ revoked: true });
}
