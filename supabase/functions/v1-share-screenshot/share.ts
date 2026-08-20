export const MAX_SHARE_BODY_BYTES = 2 * 1024;
export const MAX_SHARED_IMAGE_BYTES = 25 * 1024 * 1024;
export const PUBLIC_IMAGE_REQUEST_LIMIT = 12;

const TOKEN = /^sh_[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const EXPIRIES = new Set([3_600, 86_400, 604_800, 2_592_000]);
const PBKDF2_ITERATIONS = 210_000;
const MAX_ACTIVE_LINKS = 20;
const PUBLIC_INSPECT_REQUEST_LIMIT = 60;
const PUBLIC_GLOBAL_REQUEST_LIMIT = 600;
const PUBLIC_RATE_WINDOW_MS = 60_000;
const PUBLIC_RATE_BUCKETS = 2_048;

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ShareDependencies = {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetcher?: Fetcher;
  now?: () => Date;
  randomBytes?: (length: number) => Uint8Array;
};

type ShareRow = {
  id: string;
  user_id: string;
  screenshot_id: string;
  token_hash?: string;
  password_hash: string | null;
  password_salt: string | null;
  password_iterations?: number | null;
  storage_path: string;
  expires_at: string;
  one_time: boolean;
  consumed_at: string | null;
  revoked_at: string | null;
  view_count?: number;
  created_at?: string;
};

type JsonRecord = Record<string, unknown>;

function json(body: unknown, status = 200, extraHeaders: HeadersInit = {}) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...Object.fromEntries(new Headers(extraHeaders)),
    },
  });
}

type RateBucket = { startedAt: number; count: number };

function createPublicRequestLimiter(now: () => Date) {
  const buckets = new Map<string, RateBucket>();
  let global: RateBucket = { startedAt: 0, count: 0 };

  function current(bucket: RateBucket | undefined, timestamp: number) {
    return !bucket || timestamp - bucket.startedAt >= PUBLIC_RATE_WINDOW_MS
      ? { startedAt: timestamp, count: 0 }
      : bucket;
  }

  return (tokenHash: string, action: "inspect" | "image") => {
    const timestamp = now().getTime();
    global = current(global, timestamp);
    if (global.count >= PUBLIC_GLOBAL_REQUEST_LIMIT) {
      return Math.max(1, Math.ceil((global.startedAt + PUBLIC_RATE_WINDOW_MS - timestamp) / 1_000));
    }

    const key = `${action}:${tokenHash}`;
    if (!buckets.has(key) && buckets.size >= PUBLIC_RATE_BUCKETS) {
      for (const [candidate, bucket] of buckets) {
        if (timestamp - bucket.startedAt >= PUBLIC_RATE_WINDOW_MS) buckets.delete(candidate);
      }
      if (buckets.size >= PUBLIC_RATE_BUCKETS) return 60;
    }

    const bucket = current(buckets.get(key), timestamp);
    const limit = action === "image" ? PUBLIC_IMAGE_REQUEST_LIMIT : PUBLIC_INSPECT_REQUEST_LIMIT;
    if (bucket.count >= limit) {
      return Math.max(1, Math.ceil((bucket.startedAt + PUBLIC_RATE_WINDOW_MS - timestamp) / 1_000));
    }
    bucket.count += 1;
    global.count += 1;
    buckets.set(key, bucket);
    return 0;
  };
}

async function boundedBytes(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("response exceeds byte limit");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error("response exceeds byte limit");
  return bytes;
}

async function readBody(request: Request): Promise<JsonRecord | null> {
  try {
    const bytes = await boundedBytes(new Response(request.body, { headers: request.headers }), MAX_SHARE_BODY_BYTES);
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
  } catch {
    return null;
  }
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function passwordHash(password: string, salt: Uint8Array, iterations = PBKDF2_ITERATIONS) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return [...new Uint8Array(bits)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function validPassword(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const bytes = new TextEncoder().encode(value).length;
  return value.length >= 6 && bytes <= 128;
}

function statusOf(row: ShareRow, now: Date) {
  if (row.revoked_at) return "revoked" as const;
  if (row.one_time && row.consumed_at) return "consumed" as const;
  if (!Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= now.getTime()) {
    return "expired" as const;
  }
  return "ready" as const;
}

function publicLink(row: ShareRow) {
  return {
    id: row.id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    hasPassword: Boolean(row.password_hash),
    oneTime: row.one_time,
    consumedAt: row.consumed_at,
    revokedAt: row.revoked_at,
    viewCount: row.view_count ?? 0,
  };
}

function safeStoragePath(value: string, userId: string, screenshotId: string) {
  const expected = new RegExp(`^originals/${userId}/${screenshotId}\\.(png|jpe?g|webp)$`, "i");
  if (!expected.test(value)) throw new Error("invalid share storage path");
  return value.slice("originals/".length);
}

function mediaType(path: string) {
  if (/\.png$/i.test(path)) return "image/png";
  if (/\.webp$/i.test(path)) return "image/webp";
  if (/\.jpe?g$/i.test(path)) return "image/jpeg";
  throw new Error("unsupported shared image type");
}

function validImage(bytes: Uint8Array, path: string) {
  if (/\.png$/i.test(path)) {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return bytes.length >= png.length && png.every((byte, index) => bytes[index] === byte);
  }
  if (/\.jpe?g$/i.test(path)) {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (/\.webp$/i.test(path)) {
    return bytes.length >= 12 &&
      new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
      new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
  }
  return false;
}

export function createShareHandler(dependencies: ShareDependencies) {
  const base = dependencies.supabaseUrl.replace(/\/$/, "");
  const fetcher = dependencies.fetcher ?? fetch;
  const now = dependencies.now ?? (() => new Date());
  const randomBytes = dependencies.randomBytes ?? ((length: number) => crypto.getRandomValues(new Uint8Array(length)));
  const rateLimitPublicRequest = createPublicRequestLimiter(now);
  const serviceHeaders = (extra: HeadersInit = {}) => ({
    apikey: dependencies.serviceRoleKey,
    authorization: `Bearer ${dependencies.serviceRoleKey}`,
    ...Object.fromEntries(new Headers(extra)),
  });

  async function userFor(request: Request) {
    const authorization = request.headers.get("authorization") ?? "";
    if (!/^Bearer [^\s]+$/i.test(authorization)) return null;
    const response = await fetcher(`${base}/auth/v1/user`, {
      headers: { apikey: dependencies.serviceRoleKey, authorization },
    });
    if (!response.ok) return null;
    const user = JSON.parse(new TextDecoder().decode(await boundedBytes(response, 16 * 1024))) as {
      id?: string;
      is_anonymous?: boolean;
    };
    return typeof user.id === "string" && UUID.test(user.id) && !user.is_anonymous ? user.id : null;
  }

  async function rows(url: URL, init?: RequestInit): Promise<ShareRow[]> {
    const response = await fetcher(url, { ...init, headers: serviceHeaders(init?.headers) });
    if (!response.ok) throw new Error("share persistence unavailable");
    return JSON.parse(new TextDecoder().decode(await boundedBytes(response, 64 * 1024))) as ShareRow[];
  }

  async function screenshotFor(userId: string, screenshotId: string) {
    const url = new URL(`${base}/rest/v1/screenshots`);
    url.searchParams.set("select", "id,storage_path");
    url.searchParams.set("id", `eq.${screenshotId}`);
    url.searchParams.set("user_id", `eq.${userId}`);
    url.searchParams.set("limit", "1");
    const response = await fetcher(url, { headers: serviceHeaders() });
    if (!response.ok) throw new Error("screenshot lookup unavailable");
    const records = JSON.parse(new TextDecoder().decode(await boundedBytes(response, 16 * 1024))) as {
      id: string;
      storage_path: string;
    }[];
    return records[0] ?? null;
  }

  async function linkForTokenHash(tokenHash: string): Promise<ShareRow | null> {
    const url = new URL(`${base}/rest/v1/screenshot_share_links`);
    url.searchParams.set("select", "id,user_id,screenshot_id,password_hash,password_salt,password_iterations,storage_path,expires_at,one_time,consumed_at,revoked_at");
    url.searchParams.set("token_hash", `eq.${tokenHash}`);
    url.searchParams.set("limit", "1");
    return (await rows(url))[0] ?? null;
  }

  async function ownerAction(request: Request, body: JsonRecord) {
    let userId: string | null;
    try {
      userId = await userFor(request);
    } catch {
      return json({ error: "account verification unavailable" }, 503);
    }
    if (!userId) return json({ error: "unauthorized" }, 401);
    const action = body.action;
    const screenshotId = typeof body.screenshotId === "string" ? body.screenshotId : "";
    if (!UUID.test(screenshotId)) return json({ error: "invalid screenshot" }, 400);

    try {
      const screenshot = await screenshotFor(userId, screenshotId);
      if (!screenshot) return json({ error: "screenshot not found" }, 404);
      const storagePath = `originals/${safeStoragePath(screenshot.storage_path, userId, screenshotId)}`;
      const linksUrl = new URL(`${base}/rest/v1/screenshot_share_links`);

      if (action === "list") {
        linksUrl.searchParams.set("select", "id,created_at,expires_at,password_hash,one_time,consumed_at,revoked_at,view_count");
        linksUrl.searchParams.set("user_id", `eq.${userId}`);
        linksUrl.searchParams.set("screenshot_id", `eq.${screenshotId}`);
        linksUrl.searchParams.set("order", "created_at.desc");
        linksUrl.searchParams.set("limit", String(MAX_ACTIVE_LINKS));
        return json({ links: (await rows(linksUrl)).map(publicLink) });
      }

      if (action === "revoke") {
        const linkId = typeof body.linkId === "string" ? body.linkId : "";
        if (!UUID.test(linkId)) return json({ error: "invalid share link" }, 400);
        linksUrl.searchParams.set("id", `eq.${linkId}`);
        linksUrl.searchParams.set("user_id", `eq.${userId}`);
        linksUrl.searchParams.set("screenshot_id", `eq.${screenshotId}`);
        const revoked = await rows(linksUrl, {
          method: "PATCH",
          headers: { "content-type": "application/json", prefer: "return=representation" },
          body: JSON.stringify({ revoked_at: now().toISOString() }),
        });
        return revoked.length ? json({ revoked: true }) : json({ error: "share link not found" }, 404);
      }

      if (action !== "create") return json({ error: "invalid share action" }, 400);
      const expires = typeof body.expiresInSeconds === "number" ? body.expiresInSeconds : 0;
      const oneTime = body.oneTime === true;
      const rawPassword = body.password;
      if (!EXPIRIES.has(expires) || (rawPassword !== null && rawPassword !== undefined && !validPassword(rawPassword))) {
        return json({ error: "invalid share settings" }, 400);
      }

      linksUrl.searchParams.set("select", "id");
      linksUrl.searchParams.set("user_id", `eq.${userId}`);
      linksUrl.searchParams.set("screenshot_id", `eq.${screenshotId}`);
      linksUrl.searchParams.set("revoked_at", "is.null");
      linksUrl.searchParams.set("expires_at", `gt.${now().toISOString()}`);
      linksUrl.searchParams.set("or", "(one_time.eq.false,consumed_at.is.null)");
      linksUrl.searchParams.set("limit", String(MAX_ACTIVE_LINKS));
      if ((await rows(linksUrl)).length >= MAX_ACTIVE_LINKS) {
        return json({ error: "revoke an existing link before creating another" }, 409);
      }

      const token = `sh_${bytesToBase64Url(randomBytes(32))}`;
      const salt = rawPassword ? randomBytes(16) : null;
      const createdAt = now();
      const record = {
        user_id: userId,
        screenshot_id: screenshotId,
        token_hash: await sha256(token),
        password_hash: salt && typeof rawPassword === "string"
          ? await passwordHash(rawPassword, salt)
          : null,
        password_salt: salt ? bytesToBase64Url(salt) : null,
        password_iterations: salt ? PBKDF2_ITERATIONS : null,
        storage_path: storagePath,
        expires_at: new Date(createdAt.getTime() + expires * 1_000).toISOString(),
        one_time: oneTime,
      };
      const inserted = await rows(new URL(`${base}/rest/v1/screenshot_share_links`), {
        method: "POST",
        headers: { "content-type": "application/json", prefer: "return=representation" },
        body: JSON.stringify(record),
      });
      const link = inserted[0];
      if (!link) throw new Error("share insert returned no row");
      return json({ token, link: publicLink({ ...record, ...link } as ShareRow) }, 201);
    } catch {
      return json({ error: "share link service unavailable" }, 503);
    }
  }

  async function publicAction(request: Request, body: JsonRecord) {
    const token = request.headers.get("x-capso-share-token") ?? "";
    const action = request.headers.get("x-capso-share-action") ?? "";
    if (!TOKEN.test(token) || !["inspect", "image"].includes(action)) {
      return json({ status: "not_found" }, 404);
    }
    const tokenHash = await sha256(token);
    const retryAfterSeconds = rateLimitPublicRequest(tokenHash, action as "inspect" | "image");
    if (retryAfterSeconds) {
      return json({ status: "rate_limited" }, 429, { "retry-after": String(retryAfterSeconds) });
    }
    let row: ShareRow | null;
    try {
      row = await linkForTokenHash(tokenHash);
    } catch {
      return json({ error: "private link service unavailable" }, 503);
    }
    if (!row) return json({ status: "not_found" }, 404);
    const state = statusOf(row, now());
    if (state !== "ready") return json({ status: state }, 410);
    if (action === "inspect") {
      return json({
        status: "ready",
        requiresPassword: Boolean(row.password_hash),
        expiresAt: row.expires_at,
        oneTime: row.one_time,
      });
    }

    if (row.password_hash) {
      const password = body.password;
      if (
        !validPassword(password) || !row.password_salt ||
        !Number.isInteger(row.password_iterations) ||
        !constantEqual(
          await passwordHash(password, base64UrlToBytes(row.password_salt), row.password_iterations!),
          row.password_hash,
        )
      ) {
        return json({ status: "password_required" }, 401);
      }
    }

    try {
      const objectPath = safeStoragePath(row.storage_path, row.user_id, row.screenshot_id);
      const encoded = objectPath.split("/").map(encodeURIComponent).join("/");
      const download = await fetcher(`${base}/storage/v1/object/authenticated/originals/${encoded}`, {
        headers: serviceHeaders(),
      });
      if (!download.ok) throw new Error("shared image download failed");
      const bytes = await boundedBytes(download, MAX_SHARED_IMAGE_BYTES);
      if (!validImage(bytes, row.storage_path)) throw new Error("shared image signature mismatch");
      const consume = await fetcher(`${base}/rest/v1/rpc/consume_screenshot_share`, {
        method: "POST",
        headers: serviceHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ p_token_hash: tokenHash }),
      });
      if (!consume.ok) throw new Error("share consume failed");
      const consumed = JSON.parse(new TextDecoder().decode(await boundedBytes(consume, 16 * 1024))) as {
        storage_path?: string;
      }[];
      if (consumed[0]?.storage_path !== row.storage_path) return json({ status: "consumed" }, 410);
      return new Response(bytes, {
        headers: {
          "content-type": mediaType(row.storage_path),
          "content-length": String(bytes.length),
          "content-disposition": `inline; filename="capso-shared-capture.${row.storage_path.split(".").pop()}"`,
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy": "default-src 'none'",
        },
      });
    } catch {
      return json({ error: "private image delivery unavailable" }, 503);
    }
  }

  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }
    const body = await readBody(request);
    if (!body) return json({ error: "invalid or oversized request" }, 400);
    return request.headers.has("x-capso-share-action")
      ? publicAction(request, body)
      : ownerAction(request, body);
  };
}
