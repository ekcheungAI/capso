import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1.0.14";
import { createShareHandler, PUBLIC_IMAGE_REQUEST_LIMIT } from "./share.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SHOT_ID = "22222222-2222-4222-8222-222222222222";
const LINK_ID = "33333333-3333-4333-8333-333333333333";
const TOKEN = `sh_${"A".repeat(43)}`;
const FIXED_NOW = () => new Date("2026-08-13T00:00:00Z");

function ownerRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/functions/v1/v1-share-screenshot", {
    method: "POST",
    headers: { authorization: "Bearer owner-jwt", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function publicRequest(action: "inspect" | "image", password?: string) {
  return new Request("http://localhost/functions/v1/v1-share-screenshot", {
    method: "POST",
    headers: {
      "x-capso-share-action": action,
      "x-capso-share-token": TOKEN,
      "content-type": "application/json",
    },
    body: JSON.stringify({ password }),
  });
}

Deno.test("owner creation stores only token/password hashes and returns the raw token once", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const handler = createShareHandler({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service-test",
    now: FIXED_NOW,
    randomBytes: (length) => new Uint8Array(length).fill(length === 32 ? 0 : 1),
    fetcher: async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      assert(!url.includes(TOKEN));
      if (url.endsWith("/auth/v1/user")) {
        return Response.json({ id: USER_ID, is_anonymous: false });
      }
      if (url.includes("/screenshots?")) {
        return Response.json([{ id: SHOT_ID, storage_path: `originals/${USER_ID}/${SHOT_ID}.png` }]);
      }
      if (url.includes("/screenshot_share_links?") && init?.method !== "POST") {
        return Response.json([]);
      }
      if (url.endsWith("/screenshot_share_links")) {
        const body = JSON.parse(String(init?.body));
        assertMatch(body.token_hash, /^[0-9a-f]{64}$/);
        assertMatch(body.password_hash, /^[0-9a-f]{64}$/);
        assertMatch(body.password_salt, /^[A-Za-z0-9_-]+$/);
        assert(!String(init?.body).includes("secret phrase"));
        assert(!String(init?.body).includes(TOKEN));
        return Response.json([{ id: LINK_ID, expires_at: "2026-08-14T00:00:00Z" }]);
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });

  const response = await handler(ownerRequest({
    action: "create",
    screenshotId: SHOT_ID,
    expiresInSeconds: 86_400,
    password: "secret phrase",
    oneTime: true,
  }));
  assertEquals(response.status, 201);
  const result = await response.json();
  assertMatch(result.token, /^sh_[A-Za-z0-9_-]{43}$/);
  assertEquals(result.link.id, LINK_ID);
  assert(calls.every(({ url }) => !url.includes(result.token)));
  const activeLookup = calls.find(({ url }) => url.includes("/screenshot_share_links?") && url.includes("revoked_at=is.null"));
  assert(activeLookup);
  assertMatch(activeLookup.url, /expires_at=gt\./);
  assertMatch(activeLookup.url, /or=%28one_time\.eq\.false%2Cconsumed_at\.is\.null%29/);
});

Deno.test("public inspection hashes the header token and returns no screenshot metadata", async () => {
  const calls: string[] = [];
  const handler = createShareHandler({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service-test",
    now: FIXED_NOW,
    fetcher: async (input) => {
      const url = String(input);
      calls.push(url);
      assert(!url.includes(TOKEN));
      return Response.json([{
        id: LINK_ID,
        password_hash: null,
        password_salt: null,
        expires_at: "2026-08-14T00:00:00Z",
        one_time: false,
        consumed_at: null,
        revoked_at: null,
      }]);
    },
  });

  const response = await handler(publicRequest("inspect"));
  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    status: "ready",
    requiresPassword: false,
    expiresAt: "2026-08-14T00:00:00Z",
    oneTime: false,
  });
  assertMatch(calls[0]!, /token_hash=eq\.[0-9a-f]{64}/);
});

Deno.test("password failure never reads pixels while successful delivery streams bounded private bytes", async () => {
  let downloads = 0;
  let consumes = 0;
  const protectedHandler = createShareHandler({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service-test",
    now: FIXED_NOW,
    fetcher: async (input) => {
      const url = String(input);
      if (url.includes("/screenshot_share_links?")) {
        return Response.json([{
          id: LINK_ID,
          screenshot_id: SHOT_ID,
          user_id: USER_ID,
          password_hash: "0".repeat(64),
          password_salt: "AQEBAQEBAQEBAQEBAQEBAQ",
          password_iterations: 100_000,
          expires_at: "2026-08-14T00:00:00Z",
          one_time: false,
          consumed_at: null,
          revoked_at: null,
          storage_path: `originals/${USER_ID}/${SHOT_ID}.png`,
        }]);
      }
      downloads += Number(url.includes("/storage/v1/object/authenticated/"));
      consumes += Number(url.endsWith("/rpc/consume_screenshot_share"));
      throw new Error(`password failure must not fetch ${url}`);
    },
  });

  const denied = await protectedHandler(publicRequest("image", "wrong password"));
  assertEquals(denied.status, 401);
  assertEquals(await denied.json(), { status: "password_required" });
  assertEquals(downloads, 0);
  assertEquals(consumes, 0);

  const handler = createShareHandler({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service-test",
    now: FIXED_NOW,
    fetcher: async (input, init) => {
      const url = String(input);
      if (url.includes("/screenshot_share_links?")) {
        return Response.json([{
          id: LINK_ID,
          screenshot_id: SHOT_ID,
          user_id: USER_ID,
          password_hash: null,
          password_salt: null,
          expires_at: "2026-08-14T00:00:00Z",
          one_time: true,
          consumed_at: null,
          revoked_at: null,
          storage_path: `originals/${USER_ID}/${SHOT_ID}.png`,
        }]);
      }
      if (url.includes("/storage/v1/object/authenticated/")) {
        downloads += 1;
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
          headers: { "content-type": "image/png", "content-length": "8" },
        });
      }
      if (url.endsWith("/rpc/consume_screenshot_share")) {
        consumes += 1;
        assertMatch(JSON.parse(String(init?.body)).p_token_hash, /^[0-9a-f]{64}$/);
        return Response.json([{ storage_path: `originals/${USER_ID}/${SHOT_ID}.png` }]);
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });

  const response = await handler(publicRequest("image"));
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("content-type"), "image/png");
  assertEquals(response.headers.get("cache-control"), "private, no-store");
  assertEquals(downloads, 1);
  assertEquals(consumes, 1);
});

Deno.test("mismatched private image bytes fail closed before one-time consumption", async () => {
  let consumes = 0;
  const handler = createShareHandler({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service-test",
    now: FIXED_NOW,
    fetcher: async (input) => {
      const url = String(input);
      if (url.includes("/screenshot_share_links?")) {
        return Response.json([{
          id: LINK_ID,
          screenshot_id: SHOT_ID,
          user_id: USER_ID,
          password_hash: null,
          password_salt: null,
          expires_at: "2026-08-14T00:00:00Z",
          one_time: true,
          consumed_at: null,
          revoked_at: null,
          storage_path: `originals/${USER_ID}/${SHOT_ID}.png`,
        }]);
      }
      if (url.includes("/storage/v1/object/authenticated/")) {
        return new Response(new Uint8Array([0x3c, 0x73, 0x63, 0x72, 0x69, 0x70, 0x74, 0x3e]));
      }
      if (url.endsWith("/rpc/consume_screenshot_share")) consumes += 1;
      throw new Error(`unexpected fetch ${url}`);
    },
  });

  const response = await handler(publicRequest("image"));
  assertEquals(response.status, 503);
  assertEquals(consumes, 0);
});

Deno.test("public image attempts are bounded by token hash before another persistence lookup", async () => {
  let lookups = 0;
  const handler = createShareHandler({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service-test",
    now: FIXED_NOW,
    fetcher: async (input) => {
      const url = String(input);
      assert(!url.includes(TOKEN));
      lookups += 1;
      return Response.json([]);
    },
  });

  for (let attempt = 0; attempt < PUBLIC_IMAGE_REQUEST_LIMIT; attempt += 1) {
    assertEquals((await handler(publicRequest("image"))).status, 404);
  }
  const limited = await handler(publicRequest("image"));
  assertEquals(limited.status, 429);
  assertEquals(limited.headers.get("retry-after"), "60");
  assertEquals(lookups, PUBLIC_IMAGE_REQUEST_LIMIT);
});
