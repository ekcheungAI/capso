import assert from "node:assert/strict";
import test from "node:test";
import { bearerHeaders, isSameOrigin, verifyBearer } from "./auth-guard.ts";

test("missing or malformed bearer credentials never reach the verifier", async () => {
  let calls = 0;
  const verify = async () => {
    calls += 1;
    return { id: "owner-1" };
  };

  assert.deepEqual(await verifyBearer(null, verify), { ok: false, status: 401, error: "unauthorized" });
  assert.deepEqual(await verifyBearer("Basic abc", verify), { ok: false, status: 401, error: "unauthorized" });
  assert.deepEqual(await verifyBearer("Bearer ", verify), { ok: false, status: 401, error: "unauthorized" });
  assert.equal(calls, 0);
});

test("a verified bearer token becomes the only trusted owner identity", async () => {
  const seen: string[] = [];
  const result = await verifyBearer("Bearer durable-token", async (token) => {
    seen.push(token);
    return { id: "owner-1" };
  });

  assert.deepEqual(seen, ["durable-token"]);
  assert.deepEqual(result, { ok: true, token: "durable-token", userId: "owner-1" });
});

test("invalid users are unauthorized and verifier outages are not exposed", async () => {
  assert.deepEqual(await verifyBearer("Bearer expired", async () => null), {
    ok: false,
    status: 401,
    error: "unauthorized",
  });
  assert.deepEqual(
    await verifyBearer("Bearer token", async () => {
      throw new Error("upstream auth detail");
    }),
    { ok: false, status: 503, error: "authentication unavailable" },
  );
});

test("authenticated client headers preserve content type and replace spoofed credentials", () => {
  const headers = bearerHeaders(
    { "content-type": "application/json", authorization: "Bearer attacker" },
    "real-token",
  );

  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("authorization"), "Bearer real-token");
});

test("same-origin uses the public host even when a framework normalizes the internal URL", () => {
  const local = new Request("http://localhost:3012/api/chat", {
    headers: { host: "127.0.0.1:3012", origin: "http://127.0.0.1:3012" },
  });
  const proxied = new Request("http://internal:3000/api/chat", {
    headers: {
      host: "internal:3000",
      origin: "https://capso.example",
      "x-forwarded-host": "capso.example",
      "x-forwarded-proto": "https",
    },
  });
  const attacker = new Request("http://localhost:3012/api/chat", {
    headers: { host: "127.0.0.1:3012", origin: "https://attacker.example" },
  });

  assert.equal(isSameOrigin(local), true);
  assert.equal(isSameOrigin(proxied), true);
  assert.equal(isSameOrigin(attacker), false);
});
