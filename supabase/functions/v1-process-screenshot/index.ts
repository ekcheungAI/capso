import { MiniMaxClassificationProvider } from "./minimax.ts";
import { SupabaseWorkerRepository } from "./repository.ts";
import {
  type ClassificationProvider,
  processOne,
  type WorkerRepository,
} from "./worker.ts";

type HandlerDependencies = {
  workerSecret: string;
  repository: WorkerRepository;
  provider: ClassificationProvider;
  workerId?: string;
};

function constantTimeEqual(actual: string | null, expected: string) {
  const left = new TextEncoder().encode(actual ?? "");
  const right = new TextEncoder().encode(expected);
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export function createHandler(dependencies: HandlerDependencies) {
  const workerId = dependencies.workerId ?? crypto.randomUUID();
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }
    if (
      !constantTimeEqual(
        request.headers.get("x-capso-worker-secret"),
        dependencies.workerSecret,
      )
    ) {
      return json({
        error: {
          code: "unauthorized",
          message: "Worker authorization failed",
          retryable: false,
        },
      }, 401);
    }

    try {
      return json(
        await processOne(
          dependencies.repository,
          dependencies.provider,
          workerId,
        ),
      );
    } catch {
      return json({
        error: {
          code: "internal",
          message: "Worker pass failed",
          retryable: true,
        },
      }, 500);
    }
  };
}

function required(name: string) {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function createProductionHandler() {
  const workerSecret = required("CAPSO_WORKER_SECRET");
  if (workerSecret.length < 32) {
    throw new Error("CAPSO_WORKER_SECRET must contain at least 32 characters");
  }
  return createHandler({
    workerSecret,
    repository: new SupabaseWorkerRepository({
      url: required("SUPABASE_URL"),
      serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
    }),
    provider: new MiniMaxClassificationProvider({
      apiKey: required("MINIMAX_TEXT_API_KEY"),
      baseUrl: Deno.env.get("MINIMAX_API_BASE_URL")?.trim(),
      model: Deno.env.get("MINIMAX_MODEL")?.trim(),
    }),
  });
}

if (import.meta.main) Deno.serve(createProductionHandler());
