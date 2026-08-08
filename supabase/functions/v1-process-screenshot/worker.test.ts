import assert from "node:assert/strict";
import { MAX_PROMPT_BYTES, utf8Length } from "./bounds.ts";
import {
  type ClaimedJob,
  type ClassificationCall,
  type ClassificationProvider,
  type ProcessCompletion,
  type ProcessFailure,
  processOne,
  type WorkerContext,
  type WorkerRepository,
} from "./worker.ts";

const JOB: ClaimedJob = {
  id: 17,
  userId: "018f22c4-cada-7c6b-9d5b-fc35f7f92279",
  screenshotId: "018f22c4-cada-7c6b-9d5b-fc35f7f92270",
  storagePath:
    "018f22c4-cada-7c6b-9d5b-fc35f7f92279/018f22c4-cada-7c6b-9d5b-fc35f7f92270.png",
  attempt: 1,
  maxAttempts: 3,
  workerId: "worker-test",
  pageUrl: null,
  pageTitle: null,
};

const CONTEXT: WorkerContext = {
  image: { mediaType: "image/png", base64: "iVBORw0KGgo=" },
  projects: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Pricing teardown",
      description: "Competitor pricing and packaging",
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Hooks",
      description: "Marketing hooks and copy",
    },
  ],
  corrections: Array.from(
    { length: 20 },
    (_, index) => `Correction ${20 - index}`,
  ),
  pageUrl: null,
  pageTitle: null,
};

function modelResult(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    title: "Competitor pricing",
    ocr_text: "Starter Pro Enterprise",
    summary: "A competitor pricing page with three plans.",
    type: "web_page",
    intent: "competitor",
    project_suggestion: "Pricing teardown",
    confidence: 0.91,
    why_saved: "Compare packaging and price anchors.",
    tags: ["pricing table"],
    ...overrides,
  });
}

class FakeRepository implements WorkerRepository {
  claimed: ClaimedJob | null = JOB;
  context = CONTEXT;
  completions: ProcessCompletion[] = [];
  failures: ProcessFailure[] = [];
  claims = 0;

  claim(): Promise<ClaimedJob | null> {
    this.claims += 1;
    return Promise.resolve(this.claimed);
  }

  loadContext(job: ClaimedJob): Promise<WorkerContext> {
    assert.equal(job, JOB);
    return Promise.resolve(this.context);
  }

  complete(completion: ProcessCompletion): Promise<void> {
    this.completions.push(completion);
    return Promise.resolve();
  }

  fail(failure: ProcessFailure): Promise<"retry_scheduled"> {
    this.failures.push(failure);
    return Promise.resolve("retry_scheduled");
  }
}

class FakeProvider implements ClassificationProvider {
  calls: ClassificationCall[] = [];
  replies: string[] = [modelResult()];

  classify(call: ClassificationCall): Promise<string> {
    this.calls.push(call);
    const next = this.replies.shift();
    if (next === undefined) throw new Error("unexpected model call");
    return Promise.resolve(next);
  }
}

Deno.test("one wake claims and completes exactly one stored screenshot without a browser", async () => {
  const repository = new FakeRepository();
  const provider = new FakeProvider();

  const report = await processOne(repository, provider, "worker-test");

  assert.deepEqual(report, {
    status: "processed",
    jobId: JOB.id,
    screenshotId: JOB.screenshotId,
  });
  assert.equal(repository.claims, 1);
  assert.equal(provider.calls.length, 1);
  assert.match(provider.calls[0]!.prompt, /Pricing teardown/);
  assert.match(provider.calls[0]!.prompt, /Correction 20/);
  assert.match(provider.calls[0]!.prompt, /Correction 1/);
  assert.equal(repository.failures.length, 0);
  assert.equal(repository.completions.length, 1);
  assert.equal(repository.completions[0]!.job, JOB);
  assert.equal(
    repository.completions[0]!.suggestedThreadId,
    CONTEXT.projects[0]!.id,
  );
  assert.equal(
    repository.completions[0]!.autoAssignThreadId,
    CONTEXT.projects[0]!.id,
  );
  assert.equal(
    repository.completions[0]!.analysis.project_suggestion,
    "Pricing teardown",
  );
});

Deno.test("an idle wake makes no storage or model call", async () => {
  const repository = new FakeRepository();
  repository.claimed = null;
  const provider = new FakeProvider();

  assert.deepEqual(await processOne(repository, provider, "worker-test"), {
    status: "idle",
  });
  assert.equal(provider.calls.length, 0);
  assert.equal(repository.completions.length, 0);
  assert.equal(repository.failures.length, 0);
});

Deno.test("invalid model JSON receives exactly one schema repair", async () => {
  const repository = new FakeRepository();
  const provider = new FakeProvider();
  provider.replies = ["not json", modelResult({ confidence: 0.66 })];

  await processOne(repository, provider, "worker-test");

  assert.equal(provider.calls.length, 2);
  assert.equal(provider.calls[0]!.repairError, null);
  assert.match(provider.calls[1]!.repairError ?? "", /JSON|schema/i);
  assert.equal(repository.completions.length, 1);
  assert.equal(repository.failures.length, 0);
});

Deno.test("two invalid responses schedule a generic retry and preserve the screenshot", async () => {
  const repository = new FakeRepository();
  const provider = new FakeProvider();
  provider.replies = ["not json", "still not json"];

  const report = await processOne(repository, provider, "worker-test");

  assert.deepEqual(report, {
    status: "retry_scheduled",
    jobId: JOB.id,
    screenshotId: JOB.screenshotId,
  });
  assert.equal(provider.calls.length, 2);
  assert.equal(repository.completions.length, 0);
  assert.deepEqual(repository.failures, [{
    job: JOB,
    code: "invalid_model_output",
  }]);
});

Deno.test("a provider exception stores no provider body or screenshot metadata", async () => {
  const repository = new FakeRepository();
  const provider: ClassificationProvider = {
    classify() {
      throw new Error("MiniMax 500: secret provider response");
    },
  };

  await processOne(repository, provider, "worker-test");

  assert.deepEqual(repository.failures, [{
    job: JOB,
    code: "provider_unavailable",
  }]);
});

Deno.test("high confidence cannot auto-assign an invented or ambiguous project", async () => {
  const repository = new FakeRepository();
  const provider = new FakeProvider();
  provider.replies = [
    modelResult({ project_suggestion: "Invented project", confidence: 0.99 }),
  ];

  await processOne(repository, provider, "worker-test");

  assert.equal(repository.completions[0]!.suggestedThreadId, null);
  assert.equal(repository.completions[0]!.autoAssignThreadId, null);
});

Deno.test("untrusted context stays inside the total UTF-8 prompt budget", async () => {
  const repository = new FakeRepository();
  repository.context = {
    ...CONTEXT,
    projects: Array.from({ length: 50 }, (_, index) => ({
      id: crypto.randomUUID(),
      name: `Project ${index} ${"名".repeat(500)}`,
      description: "說明".repeat(10_000),
    })),
    corrections: Array.from(
      { length: 20 },
      (_, index) => `Correction ${index} ${"內容".repeat(10_000)}`,
    ),
    pageUrl: `https://example.com/${"路徑".repeat(10_000)}`,
    pageTitle: "標題".repeat(10_000),
  };
  const provider = new FakeProvider();
  provider.replies = [modelResult({ project_suggestion: null })];

  await processOne(repository, provider, "worker-test");

  assert.ok(utf8Length(provider.calls[0]!.prompt) <= MAX_PROMPT_BYTES);
  assert.match(provider.calls[0]!.prompt, /Project 49/);
  assert.match(provider.calls[0]!.prompt, /Correction 19/);
  assert.match(provider.calls[0]!.prompt, /Untrusted browser-page context/);
  assert.ok(provider.calls[0]!.prompt.endsWith("Classify the screenshot."));
  assert.equal(repository.completions.length, 1);
});
