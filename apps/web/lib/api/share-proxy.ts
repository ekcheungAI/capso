import "server-only";
import { SHARE_TOKEN } from "@/lib/share-link";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

type ShareProxyOptions = {
  authorization?: string;
  action?: "inspect" | "image";
  token?: string;
  body: unknown;
};

async function boundedBody(response: Response, limit: number) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new Error("share response too large");
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel("share response too large").catch(() => undefined);
        throw new Error("share response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function shareServiceConfigured() {
  return Boolean(url && anonKey);
}

export async function callShareService(options: ShareProxyOptions) {
  if (!url || !anonKey) throw new Error("share service unavailable");
  if (options.token !== undefined && !SHARE_TOKEN.test(options.token)) {
    throw new Error("invalid share token");
  }
  const headers = new Headers({
    apikey: anonKey,
    authorization: options.authorization ?? `Bearer ${anonKey}`,
    "content-type": "application/json",
  });
  if (options.action) headers.set("x-capso-share-action", options.action);
  if (options.token) headers.set("x-capso-share-token", options.token);

  const response = await fetch(`${url.replace(/\/$/, "")}/functions/v1/v1-share-screenshot`, {
    method: "POST",
    headers,
    body: JSON.stringify(options.body),
    cache: "no-store",
  });
  const mediaType = response.headers.get("content-type") ?? "application/json";
  const normalizedMediaType = mediaType.split(";", 1)[0]!.trim().toLowerCase();
  const isImage = ["image/png", "image/jpeg", "image/webp"].includes(normalizedMediaType);
  const rawRetryAfter = response.headers.get("retry-after");
  const retryAfter = rawRetryAfter && /^\d{1,3}$/.test(rawRetryAfter) && Number(rawRetryAfter) <= 300
    ? rawRetryAfter
    : null;
  return {
    status: response.status,
    mediaType: isImage ? normalizedMediaType : "application/json",
    retryAfter,
    body: await boundedBody(response, isImage ? MAX_IMAGE_BYTES : MAX_JSON_BYTES),
  };
}
