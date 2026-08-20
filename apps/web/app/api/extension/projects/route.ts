import { EXTENSION_DEVICE_TOKEN } from "@/lib/extension-device";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function cors(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin?.startsWith("chrome-extension://")) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "x-capso-device",
    "access-control-allow-methods": "GET, OPTIONS",
    vary: "origin",
  };
}

function json(request: Request, body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { ...cors(request), "cache-control": "no-store" },
  });
}

export async function GET(request: Request) {
  if (!request.headers.get("origin")?.startsWith("chrome-extension://")) {
    return json(request, { error: "forbidden" }, 403);
  }
  const token = request.headers.get("x-capso-device") ?? "";
  if (!EXTENSION_DEVICE_TOKEN.test(token)) {
    return json(request, { error: "device code required" }, 401);
  }
  if (!url || !anonKey) return json(request, { error: "projects unavailable" }, 501);

  try {
    const upstream = await fetch(
      `${url.replace(/\/$/, "")}/functions/v1/v1-extension-ingest`,
      {
        headers: {
          apikey: anonKey,
          "x-capso-device": token,
        },
        cache: "no-store",
      },
    );
    if (upstream.status === 404) {
      return json(request, { error: "project choice is not installed" }, 501);
    }
    const body = await upstream.json().catch(() => ({ error: "invalid project response" }));
    return json(request, body, upstream.status);
  } catch {
    return json(request, { error: "projects unavailable" }, 503);
  }
}

export async function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: cors(request) });
}
