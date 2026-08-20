import { isSameOrigin } from "@/lib/api/auth-guard";
import { callShareService, shareServiceConfigured } from "@/lib/api/share-proxy";
import { SHARE_TOKEN } from "@/lib/share-link";

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "forbidden" }, { status: 403 });
  if (!shareServiceConfigured()) return Response.json({ error: "sharing unavailable" }, { status: 503 });
  const token = request.headers.get("x-capso-share-token") ?? "";
  if (!SHARE_TOKEN.test(token)) return Response.json({ status: "not_found" }, { status: 404 });

  try {
    const response = await callShareService({ action: "inspect", token, body: {} });
    const headers = new Headers({
      "content-type": "application/json",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    if (response.retryAfter) headers.set("retry-after", response.retryAfter);
    return new Response(response.body, {
      status: response.status,
      headers,
    });
  } catch {
    return Response.json({ error: "private link unavailable" }, { status: 503 });
  }
}
