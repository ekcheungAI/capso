export const MAX_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_ORIGINAL_BYTES = Math.floor(2.25 * 1024 * 1024);
export const MAX_THUMB_BYTES = 512 * 1024;

const DEVICE_TOKEN = /^d_[A-Za-z0-9_-]{16,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type IngestDependencies = {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetcher?: Fetcher;
};

type DeviceRow = {
  id: string;
  user_id: string;
};

type CaptureBody = {
  id?: unknown;
  deviceToken?: unknown;
  imageDataUrl?: unknown;
  thumbDataUrl?: unknown;
  capturedAt?: unknown;
  width?: unknown;
  height?: unknown;
  contentHash?: unknown;
  pageUrl?: unknown;
  pageTitle?: unknown;
  sourceApp?: unknown;
  projectId?: unknown;
  check?: unknown;
};

type ProjectRow = {
  id: string;
  name: string;
  description: string | null;
  last_active_at: string;
};

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function boundedBytes(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error("response exceeds byte limit");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error("response exceeds byte limit");
  return bytes;
}

async function readBody(request: Request): Promise<CaptureBody | null> {
  try {
    const bytes = await boundedBytes(new Response(request.body, {
      headers: request.headers,
    }), MAX_BODY_BYTES);
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as CaptureBody
      : null;
  } catch {
    return null;
  }
}

function base64Bytes(value: unknown, mediaType: "image/jpeg" | "image/webp", maxBytes: number) {
  if (typeof value !== "string") return null;
  const prefix = `data:${mediaType};base64,`;
  if (!value.startsWith(prefix)) return null;
  const encoded = value.slice(prefix.length);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) return null;
  if (Math.floor(encoded.length * 3 / 4) > maxBytes) return null;
  try {
    const binary = atob(encoded);
    if (binary.length === 0 || binary.length > maxBytes) return null;
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function isJpeg(bytes: Uint8Array) {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function isWebp(bytes: Uint8Array) {
  return bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP";
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function cleanString(value: unknown, max: number) {
  return typeof value === "string" && value.length <= max ? value : null;
}

export function createIngestHandler(dependencies: IngestDependencies) {
  const base = dependencies.supabaseUrl.replace(/\/$/, "");
  const fetcher = dependencies.fetcher ?? fetch;
  const serviceHeaders = (extra: HeadersInit = {}) => ({
    apikey: dependencies.serviceRoleKey,
    authorization: `Bearer ${dependencies.serviceRoleKey}`,
    ...Object.fromEntries(new Headers(extra)),
  });

  async function deviceFor(rawToken: string): Promise<DeviceRow | null> {
    const url = new URL(`${base}/rest/v1/extension_devices`);
    url.searchParams.set("select", "id,user_id");
    url.searchParams.set("token_hash", `eq.${await sha256(rawToken)}`);
    url.searchParams.set("revoked_at", "is.null");
    url.searchParams.set("limit", "1");
    const response = await fetcher(url, { headers: serviceHeaders() });
    if (!response.ok) throw new Error("device lookup failed");
    const rows = JSON.parse(new TextDecoder().decode(
      await boundedBytes(response, 16 * 1024),
    )) as DeviceRow[];
    return rows[0] ?? null;
  }

  async function upload(bucket: string, path: string, bytes: Uint8Array, mediaType: string) {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const response = await fetcher(`${base}/storage/v1/object/${bucket}/${encoded}`, {
      method: "POST",
      headers: serviceHeaders({
        "content-type": mediaType,
        // Never overwrite an object before the idempotency RPC has proved that
        // the existing screenshot identity describes the same bytes. A retry
        // sees 409 here and lets the RPC settle the equality check.
        "x-upsert": "false",
      }),
      body: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    });
    if (!response.ok && response.status !== 409) throw new Error(`${bucket} upload failed`);
  }

  return async (request: Request): Promise<Response> => {
    if (!["GET", "POST"].includes(request.method)) {
      return new Response(null, { status: 405, headers: { allow: "GET, POST" } });
    }

    const body = request.method === "POST" ? await readBody(request) : {};
    if (!body) return json({ error: "invalid or oversized request" }, 400);
    const token = typeof body.deviceToken === "string"
      ? body.deviceToken
      : request.headers.get("x-capso-device") ?? "";
    if (!DEVICE_TOKEN.test(token)) return json({ error: "device code required" }, 401);

    let device: DeviceRow | null;
    try {
      device = await deviceFor(token);
    } catch {
      return json({ error: "device lookup unavailable" }, 503);
    }
    if (!device) return json({ error: "device is not paired" }, 401);

    if (request.method === "GET") {
      try {
        const projectsUrl = new URL(`${base}/rest/v1/project_threads`);
        projectsUrl.searchParams.set("select", "id,name,description,last_active_at");
        projectsUrl.searchParams.set("user_id", `eq.${device.user_id}`);
        projectsUrl.searchParams.set("archived_at", "is.null");
        projectsUrl.searchParams.set("order", "last_active_at.desc,id.asc");
        projectsUrl.searchParams.set("limit", "50");
        const projectsResponse = await fetcher(projectsUrl, { headers: serviceHeaders() });
        if (!projectsResponse.ok) throw new Error("project lookup failed");
        const projects = JSON.parse(new TextDecoder().decode(
          await boundedBytes(projectsResponse, 64 * 1024),
        )) as ProjectRow[];
        return json({
          projects: projects.map((project) => ({
            id: project.id,
            name: project.name,
            description: project.description,
          })),
        });
      } catch {
        return json({ error: "projects unavailable" }, 503);
      }
    }

    if (body.check === true) {
      return json({ paired: true });
    }

    const id = typeof body.id === "string" ? body.id : "";
    const capturedAt = typeof body.capturedAt === "string" ? body.capturedAt : "";
    const width = typeof body.width === "number" && Number.isInteger(body.width) ? body.width : 0;
    const height = typeof body.height === "number" && Number.isInteger(body.height) ? body.height : 0;
    const hash = typeof body.contentHash === "string" ? body.contentHash.replace(/^sha256:/, "") : "";
    const pageUrl = cleanString(body.pageUrl, 2048);
    const pageTitle = cleanString(body.pageTitle, 512);
    const sourceApp = cleanString(body.sourceApp, 128);
    const projectId = body.projectId === null || body.projectId === undefined
      ? null
      : typeof body.projectId === "string" && UUID.test(body.projectId)
      ? body.projectId
      : "invalid";
    const original = base64Bytes(body.imageDataUrl, "image/jpeg", MAX_ORIGINAL_BYTES);
    const thumb = base64Bytes(body.thumbDataUrl, "image/webp", MAX_THUMB_BYTES);

    if (
      !UUID.test(id) || !SHA256.test(hash) || !Number.isFinite(Date.parse(capturedAt)) ||
      width < 1 || width > 100000 || height < 1 || height > 100000 ||
      projectId === "invalid" || !original || !thumb || !isJpeg(original) || !isWebp(thumb)
    ) {
      return json({ error: "invalid capture" }, 400);
    }

    const originalObject = `${device.user_id}/${id}.jpg`;
    const thumbObject = `${device.user_id}/${id}.webp`;
    try {
      await Promise.all([
        upload("originals", originalObject, original, "image/jpeg"),
        upload("thumbs", thumbObject, thumb, "image/webp"),
      ]);
      const rpc = await fetcher(`${base}/rest/v1/rpc/ingest_extension_capture`, {
        method: "POST",
        headers: serviceHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          p_device_id: device.id,
          p_screenshot_id: id,
          p_storage_path: `originals/${originalObject}`,
          p_thumb_path: `thumbs/${thumbObject}`,
          p_captured_at: capturedAt,
          p_content_hash: `sha256:${hash}`,
          p_width: width,
          p_height: height,
          p_bytes: original.length,
          p_page_url: pageUrl,
          p_page_title: pageTitle,
          p_source_app: sourceApp,
          p_project_id: projectId,
        }),
      });
      if (!rpc.ok) {
        const error = await rpc.json().catch(() => null) as { code?: string } | null;
        const conflict = rpc.status === 409 || error?.code === "23505";
        return json({ error: conflict ? "capture conflict" : "capture could not be persisted" }, conflict ? 409 : 502);
      }
      const result = JSON.parse(new TextDecoder().decode(
        await boundedBytes(rpc, 16 * 1024),
      )) as { screenshot_id?: string; status?: string; deduped?: boolean };
      if (result.screenshot_id !== id) return json({ error: "invalid persistence acknowledgement" }, 502);
      return json(result, result.deduped ? 200 : 201);
    } catch {
      return json({ error: "capture delivery unavailable" }, 503);
    }
  };
}
