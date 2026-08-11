import assert from "node:assert/strict";
import test from "node:test";
import { createRateLimiter } from "./rate-limit.ts";

test("the limiter enforces both owner and process-wide request budgets", () => {
  let now = 1_000;
  const limiter = createRateLimiter({ windowMs: 60_000, userLimit: 2, globalLimit: 3, now: () => now });

  assert.deepEqual(limiter.take("owner-a"), { allowed: true, retryAfterSeconds: 0 });
  assert.deepEqual(limiter.take("owner-a"), { allowed: true, retryAfterSeconds: 0 });
  assert.equal(limiter.take("owner-a").allowed, false);
  assert.deepEqual(limiter.take("owner-b"), { allowed: true, retryAfterSeconds: 0 });
  assert.equal(limiter.take("owner-c").allowed, false);

  now += 60_001;
  assert.deepEqual(limiter.take("owner-a"), { allowed: true, retryAfterSeconds: 0 });
});

test("rejections expose only a bounded Retry-After duration", () => {
  const limiter = createRateLimiter({ windowMs: 1_500, userLimit: 1, globalLimit: 10, now: () => 10_000 });
  limiter.take("owner");
  assert.deepEqual(limiter.take("owner"), { allowed: false, retryAfterSeconds: 2 });
});
