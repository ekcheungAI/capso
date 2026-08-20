import { isSameOrigin } from "@/lib/api/auth-guard";
import { callShareService, shareServiceConfigured } from "@/lib/api/share-proxy";
import { readJsonBody } from "@/lib/ai/request-guard";
import { SHARE_TOKEN } from "@/lib/share-link";

const PASSWORD_BODY_LIMIT = 512;

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "forbidden" }, { status: 403 });
  if (!shareServiceConfigured()) return Response.json({ error: "sharing unavailable" }, { status: 503 });
  const token = request.headers.get("x-capso-share-token") ?? "";
  if (!SHARE_TOKEN.test(token)) return Response.json({ status: "not_found" }, { status: 404 });
  const body = await readJsonBody(request, PASSWORD_BODY_LIMIT);
  if (!body.ok) return Response.json({ error: "invalid or oversized request" }, { status: 400 });

  try {
    const response = await callShareService({ action: "image", token, body: body.value });
    const headers = new Headers({
      "content-type": response.mediaType,
      "content-length": String(response.body.length),
      "content-disposition": response.mediaType.startsWith("image/")
        ? `inline; filename="capso-shared-capture.${response.mediaType.split("/")[1]}"`
        : "inline",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'",
    });
    if (response.retryAfter) headers.set("retry-after", response.retryAfter);
    return new Response(response.body, {
      status: response.status,
      headers,
    });
  } catch {
    return Response.json({ error: "private image unavailable" }, { status: 503 });
  }
}
