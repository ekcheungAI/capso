import assert from "node:assert/strict";
import {
  MAX_CONTEXT_RESPONSE_BYTES,
  MAX_PROJECT_DESCRIPTION_BYTES,
  utf8Length,
} from "./bounds.ts";
import {
  canonicalOriginalPath,
  SupabaseWorkerRepository,
} from "./repository.ts";
import type { ClaimedJob, ProcessCompletion } from "./worker.ts";

const USER = "018f22c4-cada-7c6b-9d5b-fc35f7f92279";
const SHOT = "018f22c4-cada-7c6b-9d5b-fc35f7f92270";

Deno.test("storage reads accept only the claimed owner and exact PNG identity", () => {
  assert.equal(
    canonicalOriginalPath(USER, SHOT, `${USER}/${SHOT}.png`),
    `${USER}/${SHOT}.png`,
  );
  assert.equal(
    canonicalOriginalPath(USER, SHOT, `originals/${USER}/${SHOT}.png`),
    `${USER}/${SHOT}.png`,
  );

  for (
    const path of [
      `other/${SHOT}.png`,
      `${USER}/other.png`,
      `${USER}/${SHOT}.jpg`,
      `${USER}/nested/${SHOT}.png`,
      `originals//${USER}/${SHOT}.png`,
      `originals/${USER}/../${SHOT}.png`,
    ]
  ) {
    assert.throws(
      () => canonicalOriginalPath(USER, SHOT, path),
      /storage path/i,
    );
  }
});

Deno.test("repository claims through service-role RPC and loads no more than 20 recent project corrections", async () => {
  const urls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith("/rpc/claim_process_capture_job")) {
      assert.equal((init as RequestInit | undefined)?.method, "POST");
      return Response.json([{
        job_id: 7,
        user_id: USER,
        screenshot_id: SHOT,
        storage_path: `${USER}/${SHOT}.png`,
        attempts: 1,
        max_attempts: 3,
        page_url: "https://example.com/pricing",
        page_title: "Pricing",
      }]);
    }
    if (url.includes("/project_threads?")) {
      return Response.json([{
        id: "11111111-1111-4111-8111-111111111111",
        name: "Pricing teardown",
        description: "界".repeat(2_000),
      }]);
    }
    if (url.includes("/user_corrections?")) {
      return Response.json([
        {
          user_value: "11111111-1111-4111-8111-111111111111",
          screenshot: {
            summary: "Another pricing page",
            intent: "competitor",
            user_id: USER,
          },
        },
        {
          user_value: "11111111-1111-4111-8111-111111111111",
          screenshot: {
            summary: "Another owner's private summary",
            intent: "reference",
            user_id: "99999999-9999-4999-8999-999999999999",
          },
        },
      ]);
    }
    if (url.includes("/storage/v1/object/authenticated/originals/")) {
      return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
        headers: { "content-type": "image/png" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const repository = new SupabaseWorkerRepository({
    url: "https://project.supabase.co",
    serviceRoleKey: "service-test",
    fetcher,
  });
  const job = await repository.claim("worker-test");
  assert.ok(job);
  const context = await repository.loadContext(job);

  assert.equal(context.image.mediaType, "image/png");
  assert.equal(context.pageUrl, "https://example.com/pricing");
  assert.equal(context.pageTitle, "Pricing");
  assert.match(context.corrections[0]!, /filed under "Pricing teardown"/);
  assert.doesNotMatch(context.corrections[0]!, /11111111/);
  assert.equal(context.corrections.length, 1);
  assert.ok(
    utf8Length(context.projects[0]!.description) <=
      MAX_PROJECT_DESCRIPTION_BYTES,
  );
  const correctionRequest = new URL(
    urls.find((url) => url.includes("user_corrections"))!,
  );
  assert.match(correctionRequest.searchParams.get("select") ?? "", /!inner/);
  assert.equal(
    correctionRequest.searchParams.get("screenshot.user_id"),
    `eq.${USER}`,
  );
  assert.ok(
    urls.some((url) =>
      url.includes("user_corrections") && url.includes("limit=20")
    ),
  );
  assert.ok(urls.every((url) => !url.includes("service-test")));
});

Deno.test("repository stops oversized context bodies before parsing them", async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/storage/v1/object/authenticated/originals/")) {
      return new Response(
        new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      );
    }
    if (url.includes("/project_threads?")) {
      return new Response("x".repeat(MAX_CONTEXT_RESPONSE_BYTES + 1));
    }
    if (url.includes("/user_corrections?")) return Response.json([]);
    throw new Error(`unexpected fetch ${url}`);
  };
  const repository = new SupabaseWorkerRepository({
    url: "https://project.supabase.co",
    serviceRoleKey: "service-test",
    fetcher,
  });
  const job: ClaimedJob = {
    id: 7,
    userId: USER,
    screenshotId: SHOT,
    storagePath: `${USER}/${SHOT}.png`,
    attempt: 1,
    maxAttempts: 3,
    workerId: "worker-test",
    pageUrl: null,
    pageTitle: null,
  };

  await assert.rejects(
    () => repository.loadContext(job),
    /byte limit/i,
  );
});

Deno.test("completion and failure settle only the exact claimed job identity", async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String((init as RequestInit | undefined)?.body)),
    });
    return String(input).endsWith("/fail_process_capture_job")
      ? Response.json("terminal")
      : Response.json(true);
  };
  const repository = new SupabaseWorkerRepository({
    url: "https://project.supabase.co",
    serviceRoleKey: "service-test",
    fetcher,
  });
  const job: ClaimedJob = {
    id: 7,
    userId: USER,
    screenshotId: SHOT,
    storagePath: `${USER}/${SHOT}.png`,
    attempt: 3,
    maxAttempts: 3,
    workerId: "worker-test",
    pageUrl: null,
    pageTitle: null,
  };
  const completion: ProcessCompletion = {
    job,
    analysis: {
      title: "Pricing",
      ocr_text: "Pro",
      summary: "A pricing page.",
      type: "web_page",
      intent: "competitor",
      project_suggestion: null,
      confidence: 0.2,
      why_saved: "Compare it.",
      tags: [],
    },
    suggestedThreadId: null,
    autoAssignThreadId: null,
    searchText: "Pricing Pro",
  };

  await repository.complete(completion);
  assert.equal(
    await repository.fail({ job, code: "provider_unavailable" }),
    "terminal",
  );
  assert.equal(calls[0]!.body.p_job_id, 7);
  assert.equal(calls[0]!.body.p_worker_id, "worker-test");
  assert.equal(calls[1]!.body.p_job_id, 7);
  assert.equal(calls[1]!.body.p_error_code, "provider_unavailable");
});
