import assert from "node:assert/strict";
import { createHandler } from "./index.ts";
import type { ClassificationProvider, WorkerRepository } from "./worker.ts";

function request(secret?: string) {
  return new Request("http://localhost/functions/v1/v1-process-screenshot", {
    method: "POST",
    headers: secret ? { "x-capso-worker-secret": secret } : {},
  });
}

function idleRepository(onClaim: () => void): WorkerRepository {
  return {
    claim() {
      onClaim();
      return Promise.resolve(null);
    },
    loadContext() {
      throw new Error("idle repository must not load context");
    },
    complete() {
      throw new Error("idle repository must not complete");
    },
    fail() {
      throw new Error("idle repository must not fail");
    },
  };
}

Deno.test("worker HTTP boundary rejects unauthorized calls before repository access", async () => {
  let claims = 0;
  const repository = idleRepository(() => claims += 1);
  const provider = {} as ClassificationProvider;
  const handler = createHandler({
    workerSecret: "expected",
    repository,
    provider,
  });

  assert.equal((await handler(request())).status, 401);
  assert.equal((await handler(request("wrong"))).status, 401);
  assert.equal(claims, 0);
});

Deno.test("authorized POST runs one worker pass while other methods are rejected", async () => {
  let claims = 0;
  const repository = idleRepository(() => claims += 1);
  const provider = {} as ClassificationProvider;
  const handler = createHandler({
    workerSecret: "expected",
    repository,
    provider,
  });

  const response = await handler(request("expected"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "idle" });
  assert.equal(claims, 1);

  const get = new Request(
    "http://localhost/functions/v1/v1-process-screenshot",
    {
      headers: { "x-capso-worker-secret": "expected" },
    },
  );
  assert.equal((await handler(get)).status, 405);
  assert.equal(claims, 1);
});
