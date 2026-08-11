import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { isSameOrigin } from "@/lib/api/auth-guard";
import {
  deleteOwnedScreenshot,
  type DeleteScreenshotPort,
} from "@/lib/api/delete-screenshot";
import { requireApiUser } from "@/lib/supabase/server-auth";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const auth = await requireApiUser(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!url || !anonKey) {
    return NextResponse.json({ error: "storage unavailable" }, { status: 503 });
  }

  const { id } = await context.params;
  if (!UUID.test(id)) {
    return NextResponse.json({ error: "invalid screenshot id" }, { status: 400 });
  }

  const client = createClient(url, anonKey, {
    global: { headers: { authorization: `Bearer ${auth.token}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const port: DeleteScreenshotPort = {
    async read(screenshotId, userId) {
      const { data, error } = await client
        .from("screenshots")
        .select("storage_path, thumb_path")
        .eq("id", screenshotId)
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw error;
      return data
        ? { storagePath: data.storage_path, thumbPath: data.thumb_path }
        : null;
    },
    async remove(bucket, objectPath) {
      const { error } = await client.storage.from(bucket).remove([objectPath]);
      if (error) throw error;
    },
    async removeRow(screenshotId, userId) {
      const { error } = await client
        .from("screenshots")
        .delete()
        .eq("id", screenshotId)
        .eq("user_id", userId);
      if (error) throw error;
    },
  };

  try {
    const result = await deleteOwnedScreenshot(id, auth.userId, port);
    return result === "not_found"
      ? NextResponse.json({ error: "not found" }, { status: 404 })
      : NextResponse.json({ deleted: true });
  } catch {
    return NextResponse.json({ error: "delete failed" }, { status: 502 });
  }
}
