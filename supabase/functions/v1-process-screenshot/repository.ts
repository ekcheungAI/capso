import type {
  ClaimedJob,
  FailureDisposition,
  ProcessCompletion,
  ProcessFailure,
  WorkerContext,
  WorkerProject,
  WorkerRepository,
} from "./worker.ts";
import {
  MAX_CONTEXT_RESPONSE_BYTES,
  MAX_CORRECTION_BYTES,
  MAX_PAGE_TITLE_BYTES,
  MAX_PAGE_URL_BYTES,
  MAX_PROJECT_DESCRIPTION_BYTES,
  MAX_PROJECT_NAME_BYTES,
  truncateUtf8,
} from "./bounds.ts";

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type RepositoryConfig = {
  url: string;
  serviceRoleKey: string;
  fetcher?: Fetcher;
};

type ClaimRow = {
  job_id: number;
  user_id: string;
  screenshot_id: string;
  storage_path: string;
  attempts: number;
  max_attempts: number;
  page_url: string | null;
  page_title: string | null;
};

type ProjectRow = { id: string; name: string; description: string | null };
type CorrectionRow = {
  user_value: string;
  screenshot: { summary: string; intent: string | null; user_id: string } | {
    summary: string;
    intent: string | null;
    user_id: string;
  }[] | null;
};

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_RPC_RESPONSE_BYTES = 64 * 1024;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const JPEG_SIGNATURE = [255, 216, 255];

function exactSegment(value: string) {
  return /^[0-9a-f-]+$/i.test(value) && !value.includes("..");
}

export function canonicalOriginalPath(
  userId: string,
  screenshotId: string,
  storagePath: string,
): string {
  const path = storagePath.startsWith("originals/")
    ? storagePath.slice("originals/".length)
    : storagePath;
  const expected = `${userId}/${screenshotId}`;
  const extension = path.slice(expected.length);
  if (
    ![".png", ".jpg", ".jpeg", ".webp"].includes(extension.toLowerCase()) ||
    !path.startsWith(expected) ||
    !exactSegment(userId) ||
    !exactSegment(screenshotId) ||
    path.split("/").length !== 2
  ) {
    throw new Error("invalid claimed storage path");
  }
  return path;
}

function imageType(path: string, bytes: Uint8Array): string | null {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  if (
    extension === ".png" &&
    PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
  ) return "image/png";
  if (
    [".jpg", ".jpeg"].includes(extension) &&
    JPEG_SIGNATURE.every((byte, index) => bytes[index] === byte)
  ) return "image/jpeg";
  if (
    extension === ".webp" && bytes.length >= 12 &&
    new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP"
  ) return "image/webp";
  return null;
}

function storageUrl(base: string, path: string) {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${base}/storage/v1/object/authenticated/originals/${encoded}`;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

async function boundedBytes(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error("worker response exceeds its byte limit");
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maxBytes) {
      throw new Error("worker response exceeds its byte limit");
    }
    return bytes;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("worker response exceeds its byte limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function boundedJson<T>(
  response: Response,
  maxBytes: number,
): Promise<T> {
  const bytes = await boundedBytes(response, maxBytes);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

function screenshotOf(row: CorrectionRow) {
  if (Array.isArray(row.screenshot)) return row.screenshot[0] ?? null;
  return row.screenshot;
}

export class SupabaseWorkerRepository implements WorkerRepository {
  readonly #url: string;
  readonly #serviceRoleKey: string;
  readonly #fetcher: Fetcher;

  constructor(config: RepositoryConfig) {
    this.#url = config.url.replace(/\/$/, "");
    this.#serviceRoleKey = config.serviceRoleKey;
    this.#fetcher = config.fetcher ?? fetch;
  }

  #headers(extra: Record<string, string> = {}) {
    return {
      apikey: this.#serviceRoleKey,
      authorization: `Bearer ${this.#serviceRoleKey}`,
      ...extra,
    };
  }

  async #json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.#fetcher(`${this.#url}${path}`, {
      ...init,
      headers: this.#headers({
        "content-type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
      }),
    });
    if (!response.ok) {
      throw new Error(
        `Supabase repository request failed (${response.status})`,
      );
    }
    return await boundedJson<T>(response, MAX_RPC_RESPONSE_BYTES);
  }

  async claim(workerId: string): Promise<ClaimedJob | null> {
    const rows = await this.#json<ClaimRow[]>(
      "/rest/v1/rpc/claim_process_capture_job",
      {
        method: "POST",
        body: JSON.stringify({ p_worker_id: workerId }),
      },
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.job_id,
      userId: row.user_id,
      screenshotId: row.screenshot_id,
      storagePath: row.storage_path,
      attempt: row.attempts,
      maxAttempts: row.max_attempts,
      workerId,
      pageUrl: row.page_url
        ? truncateUtf8(row.page_url, MAX_PAGE_URL_BYTES)
        : null,
      pageTitle: row.page_title
        ? truncateUtf8(row.page_title, MAX_PAGE_TITLE_BYTES)
        : null,
    };
  }

  async loadContext(job: ClaimedJob): Promise<WorkerContext> {
    const originalPath = canonicalOriginalPath(
      job.userId,
      job.screenshotId,
      job.storagePath,
    );

    const projectsUrl = new URL(`${this.#url}/rest/v1/project_threads`);
    projectsUrl.searchParams.set("select", "id,name,description");
    projectsUrl.searchParams.set("user_id", `eq.${job.userId}`);
    projectsUrl.searchParams.set("archived_at", "is.null");
    projectsUrl.searchParams.set("order", "last_active_at.desc,id.asc");
    projectsUrl.searchParams.set("limit", "50");

    const correctionsUrl = new URL(`${this.#url}/rest/v1/user_corrections`);
    correctionsUrl.searchParams.set(
      "select",
      "user_value,screenshot:screenshots!user_corrections_screenshot_id_fkey!inner(summary,intent,user_id)",
    );
    correctionsUrl.searchParams.set("user_id", `eq.${job.userId}`);
    correctionsUrl.searchParams.set("screenshot.user_id", `eq.${job.userId}`);
    correctionsUrl.searchParams.set("field", "eq.project");
    correctionsUrl.searchParams.set("order", "created_at.desc,id.desc");
    correctionsUrl.searchParams.set("limit", "20");

    const [imageResponse, projectsResponse, correctionsResponse] = await Promise
      .all([
        this.#fetcher(storageUrl(this.#url, originalPath), {
          headers: this.#headers(),
        }),
        this.#fetcher(projectsUrl, { headers: this.#headers() }),
        this.#fetcher(correctionsUrl, { headers: this.#headers() }),
      ]);

    if (!imageResponse.ok || !projectsResponse.ok || !correctionsResponse.ok) {
      throw new Error("worker context could not be loaded");
    }

    const imageBytes = await boundedBytes(imageResponse, MAX_IMAGE_BYTES);
    const mediaType = imageType(originalPath, imageBytes);
    if (imageBytes.length === 0 || imageBytes.length > MAX_IMAGE_BYTES || !mediaType) {
      throw new Error("claimed screenshot is not a bounded raster matching its path");
    }

    const projects = (await boundedJson<ProjectRow[]>(
      projectsResponse,
      MAX_CONTEXT_RESPONSE_BYTES,
    )).map<
      WorkerProject
    >((row) => ({
      id: row.id,
      name: truncateUtf8(row.name, MAX_PROJECT_NAME_BYTES),
      description: truncateUtf8(
        row.description ?? "",
        MAX_PROJECT_DESCRIPTION_BYTES,
      ),
    }));
    const corrections = (await boundedJson<CorrectionRow[]>(
      correctionsResponse,
      MAX_CONTEXT_RESPONSE_BYTES,
    ))
      .slice(0, 20)
      .map((row) => {
        const screenshot = screenshotOf(row);
        if (!screenshot || screenshot.user_id !== job.userId) return null;
        const projectName = row.user_value === "inbox"
          ? "Inbox"
          : projects.find((project) => project.id === row.user_value)?.name;
        if (!projectName) return null;
        return truncateUtf8(
          `Screenshot summarised as "${screenshot.summary}" → filed under "${projectName}", intent "${
            screenshot.intent ?? "other"
          }".`,
          MAX_CORRECTION_BYTES,
        );
      })
      .filter((line): line is string => line !== null);

    return {
      image: { mediaType, base64: bytesToBase64(imageBytes) },
      projects,
      corrections,
      pageUrl: job.pageUrl,
      pageTitle: job.pageTitle,
    };
  }

  async complete(completion: ProcessCompletion): Promise<void> {
    await this.#json<boolean>("/rest/v1/rpc/complete_process_capture_job", {
      method: "POST",
      body: JSON.stringify({
        p_job_id: completion.job.id,
        p_worker_id: completion.job.workerId,
        p_result: completion.analysis,
        p_suggested_thread_id: completion.suggestedThreadId,
        p_auto_assign_thread_id: completion.autoAssignThreadId,
        p_search_text: completion.searchText,
      }),
    });
  }

  async fail(failure: ProcessFailure): Promise<FailureDisposition> {
    return await this.#json<FailureDisposition>(
      "/rest/v1/rpc/fail_process_capture_job",
      {
        method: "POST",
        body: JSON.stringify({
          p_job_id: failure.job.id,
          p_worker_id: failure.job.workerId,
          p_error_code: failure.code,
        }),
      },
    );
  }
}
