import { readJsonBody } from "@/lib/ai/request-guard";
import { EXTENSION_DEVICE_TOKEN } from "@/lib/extension-device";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const BODY_LIMIT = 4 * 1024 * 1024;

function cors(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin?.startsWith("chrome-extension://")) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    vary: "origin",
  };
}

function json(request: Request, body: unknown, status = 200) {
  return Response.json(body, { status, headers: { ...cors(request), "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  if (!request.headers.get("origin")?.startsWith("chrome-extension://")) {
    return json(request, { error: "forbidden" }, 403);
  }
  const decoded = await readJsonBody(request, BODY_LIMIT);
  if (!decoded.ok) {
    return json(request, { error: decoded.error === "too_large" ? "request body is too large" : "invalid JSON body" }, decoded.error === "too_large" ? 413 : 400);
  }
  const body = decoded.value;
  const token = body && typeof body === "object" && !Array.isArray(body) && "deviceToken" in body
    ? (body as { deviceToken?: unknown }).deviceToken
    : null;
  if (typeof token !== "string" || !EXTENSION_DEVICE_TOKEN.test(token)) {
    return json(request, { error: "device code required" }, 401);
  }
  // An unconfigured/local-only build deliberately advertises the legacy relay
  // fallback. It is different from a configured backend returning a transient
  // error, which must stay queued rather than risk two delivery paths racing.
  if (!url || !anonKey) return json(request, { error: "direct delivery unavailable" }, 501);

  try {
    const upstream = await fetch(`${url.replace(/\/$/, "")}/functions/v1/v1-extension-ingest`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        "content-type": "application/json",
        "x-capso-device": token,
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (upstream.status === 404) {
      return json(request, { error: "direct delivery is not installed" }, 501);
    }
    const responseBody = await upstream.json().catch(() => ({ error: "invalid direct-delivery response" }));
    return json(request, responseBody, upstream.status);
  } catch {
    return json(request, { error: "direct delivery unavailable" }, 503);
  }
}

export async function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: cors(request) });
}
