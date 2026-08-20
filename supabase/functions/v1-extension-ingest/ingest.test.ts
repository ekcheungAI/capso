import assert from "node:assert/strict";
import { createIngestHandler } from "./ingest.ts";

const DEVICE = "d_0123456789abcdef0123456789abcdef";
const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const SHOT_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const JPEG = "data:image/jpeg;base64,/9j/4A==";
const WEBP = "data:image/webp;base64,UklGRgAAAABXRUJQ";

function request(body: Record<string, unknown>) {
  return new Request("http://localhost/functions/v1/v1-extension-ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function projectsRequest(token = DEVICE) {
  return new Request("http://localhost/functions/v1/v1-extension-ingest", {
    headers: { "x-capso-device": token },
  });
}

function capture(overrides: Record<string, unknown> = {}) {
  return {
    id: SHOT_ID,
    deviceToken: DEVICE,
    imageDataUrl: JPEG,
    thumbDataUrl: WEBP,
    capturedAt: "2026-08-12T12:00:00.000Z",
    width: 1600,
    height: 900,
    contentHash: "a".repeat(64),
    pageUrl: "https://example.com/pricing",
    pageTitle: "Pricing",
    sourceApp: "example.com",
    ...overrides,
  };
}

Deno.test("paired-device check verifies a hash and never sends the raw code upstream", async () => {
  const calls: string[] = [];
  const handler = createIngestHandler({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service-test",
    fetcher: async (input) => {
      const url = String(input);
      calls.push(url);
      assert.ok(!url.includes(DEVICE));
      return Response.json([{ id: DEVICE_ID, user_id: USER_ID }]);
    },
  });
  const response = await handler(request({ deviceToken: DEVICE, check: true }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { paired: true });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /token_hash=eq\.[0-9a-f]{64}/);
});

Deno.test("unpaired and malformed device codes are rejected before Storage access", async () => {
  let calls = 0;
  const handler = createIngestHandler({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service-test",
    fetcher: async () => {
      calls += 1;
      return Response.json([]);
    },
  });
  assert.equal((await handler(request({ deviceToken: "short", check: true }))).status, 401);
  assert.equal(calls, 0);
  assert.equal((await handler(request({ deviceToken: DEVICE, check: true }))).status, 401);
  assert.equal(calls, 1);
});

Deno.test("a paired device can read only its owner's bounded active project list", async () => {
  const calls: string[] = [];
  const handler = createIngestHandler({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service-test",
    fetcher: async (input) => {
      const url = String(input);
      calls.push(url);
      assert.ok(!url.includes(DEVICE), "raw device code must stay out of URLs");
      if (url.includes("/extension_devices?")) {
        return Response.json([{ id: DEVICE_ID, user_id: USER_ID }]);
      }
      assert.match(url, /project_threads/);
      assert.match(url, new RegExp(`user_id=eq\\.${USER_ID}`));
      assert.match(url, /archived_at=is\.null/);
      assert.match(url, /limit=50/);
      return Response.json([{
        id: PROJECT_ID,
        name: "Launch research",
        description: "Reference screenshots",
        last_active_at: "2026-08-12T12:00:00Z",
      }]);
    },
  });

  const response = await handler(projectsRequest());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    projects: [{
      id: PROJECT_ID,
      name: "Launch research",
      description: "Reference screenshots",
    }],
  });
  assert.equal(calls.length, 2);
});

Deno.test("capture bytes land only under the paired owner before one atomic RPC acknowledgement", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const handler = createIngestHandler({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service-test",
    fetcher: async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/extension_devices?")) {
        return Response.json([{ id: DEVICE_ID, user_id: USER_ID }]);
      }
      if (url.includes("/storage/v1/object/")) return Response.json({ Key: "stored" });
      if (url.endsWith("/rpc/ingest_extension_capture")) {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.p_device_id, DEVICE_ID);
        assert.equal(body.p_screenshot_id, SHOT_ID);
        assert.equal(body.p_storage_path, `originals/${USER_ID}/${SHOT_ID}.jpg`);
        assert.equal(body.p_thumb_path, `thumbs/${USER_ID}/${SHOT_ID}.webp`);
        assert.equal(body.p_content_hash, `sha256:${"a".repeat(64)}`);
        assert.equal(body.p_page_url, "https://example.com/pricing");
        assert.equal(body.p_project_id, PROJECT_ID);
        return Response.json({ screenshot_id: SHOT_ID, status: "processing", deduped: false });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });

  const response = await handler(request(capture({ projectId: PROJECT_ID })));
  assert.equal(response.status, 201);
  assert.equal((await response.json()).screenshot_id, SHOT_ID);
  assert.ok(calls.some(({ url }) => url.endsWith(`/originals/${USER_ID}/${SHOT_ID}.jpg`)));
  assert.ok(calls.some(({ url }) => url.endsWith(`/thumbs/${USER_ID}/${SHOT_ID}.webp`)));
  for (const { init } of calls) {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer service-test");
  }
  for (const { url, init } of calls.filter(({ url }) => url.includes("/storage/v1/object/"))) {
    assert.equal(new Headers(init?.headers).get("x-upsert"), "false", `${url} must not overwrite before identity verification`);
  }
});

Deno.test("idempotent RPC acknowledgement returns 200 while mismatched image signatures never upload", async () => {
  let uploads = 0;
  const handler = createIngestHandler({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service-test",
    fetcher: async (input) => {
      const url = String(input);
      if (url.includes("/extension_devices?")) {
        return Response.json([{ id: DEVICE_ID, user_id: USER_ID }]);
      }
      if (url.includes("/storage/v1/object/")) {
        uploads += 1;
        return Response.json({});
      }
      return Response.json({ screenshot_id: SHOT_ID, status: "processing", deduped: true });
    },
  });

  const bad = await handler(request(capture({ imageDataUrl: "data:image/jpeg;base64,AAAA" })));
  assert.equal(bad.status, 400);
  assert.equal(uploads, 0);

  const retry = await handler(request(capture()));
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).deduped, true);
});
