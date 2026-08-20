import { isSameOrigin } from "@/lib/api/auth-guard";
import { readJsonBody } from "@/lib/ai/request-guard";
import { callShareService, shareServiceConfigured } from "@/lib/api/share-proxy";
import { requireApiUser } from "@/lib/supabase/server-auth";

const OWNER_BODY_LIMIT = 2 * 1024;

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "forbidden" }, { status: 403 });
  const auth = await requireApiUser(request);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (!shareServiceConfigured()) return Response.json({ error: "sharing unavailable" }, { status: 503 });
  const body = await readJsonBody(request, OWNER_BODY_LIMIT);
  if (!body.ok) return Response.json({ error: "invalid or oversized request" }, { status: 400 });

  try {
    const response = await callShareService({
      authorization: `Bearer ${auth.token}`,
      body: body.value,
    });
    return new Response(response.body, {
      status: response.status,
      headers: {
        "content-type": response.mediaType,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return Response.json({ error: "sharing unavailable" }, { status: 503 });
  }
}
