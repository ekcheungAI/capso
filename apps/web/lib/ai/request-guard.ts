export const CLASSIFY_BODY_LIMIT = 10 * 1024 * 1024;
export const CHAT_BODY_LIMIT = 256 * 1024;
export const CLASSIFY_IMAGE_LIMIT = 8 * 1024 * 1024;

const PROJECT_LIMIT = 50;
const CORRECTION_LIMIT = 20;
const VOCABULARY_LIMIT = 60;
const CAPTURE_LIMIT = 12;
const HISTORY_LIMIT = 6;

type GuardResult<T> = { ok: true; value: T } | { ok: false; error: string };

type Image = { kind: "image"; mediaType: "image/png" | "image/jpeg" | "image/webp"; base64: string };
type Project = { name: string; description: string };

export type ClassifyInput = {
  image: Image;
  projects: Project[];
  corrections: string[];
  vocabulary: string[];
  pageUrl: string | null;
  pageTitle: string | null;
};

export type ChatCapture = {
  id: string;
  title: string;
  summary: string;
  ocrExcerpt: string;
  intent: string;
};

export type ChatInput = {
  question: string;
  project: string;
  captures: ChatCapture[];
  history: { role: "user" | "assistant"; text: string }[];
};

export function contentLengthAllowed(value: string | null, limit: number): boolean {
  if (value === null) return true;
  if (!/^\d+$/.test(value.trim())) return false;
  const length = Number(value);
  return Number.isSafeInteger(length) && length >= 0 && length <= limit;
}

export type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; error: "too_large" | "invalid_json" };

/**
 * Bound the bytes actually received, not only the caller-controlled
 * Content-Length header. This also covers chunked requests and dishonest
 * lengths without materialising an unbounded string first.
 */
export async function readJsonBody(request: Request, limit: number): Promise<JsonBodyResult> {
  if (!contentLengthAllowed(request.headers.get("content-length"), limit)) {
    return { ok: false, error: "too_large" };
  }

  const reader = request.body?.getReader();
  if (!reader) return { ok: false, error: "invalid_json" };

  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      received += value.byteLength;
      if (received > limit) {
        await reader.cancel("request body is too large").catch(() => undefined);
        return { ok: false, error: "too_large" };
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { ok: false, error: "invalid_json" };
  } finally {
    reader.releaseLock();
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function compact(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function boundedString(
  value: unknown,
  field: string,
  limit: number,
  { optional = false }: { optional?: boolean } = {},
): GuardResult<string> {
  if (optional && (value === undefined || value === null)) return { ok: true, value: "" };
  if (typeof value !== "string") return { ok: false, error: `${field} must be text` };
  const text = compact(value);
  if (!optional && !text) return { ok: false, error: `${field} is required` };
  if (text.length > limit) return { ok: false, error: `${field} is too long` };
  return { ok: true, value: text };
}

function boundedArray(value: unknown, field: string, limit: number): GuardResult<unknown[]> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, error: `${field} must be a list` };
  if (value.length > limit) return { ok: false, error: `${field} has too many items` };
  return { ok: true, value };
}

export function parseRasterImage(value: unknown): GuardResult<Image> {
  if (typeof value !== "string") return { ok: false, error: "imageDataUrl is required" };
  const match = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!match?.[1] || !match[2]) {
    return { ok: false, error: "imageDataUrl must be a base64 png, jpeg, or webp" };
  }
  if (match[2].length % 4 !== 0) return { ok: false, error: "imageDataUrl has invalid base64" };
  const padding = match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0;
  const bytes = (match[2].length * 3) / 4 - padding;
  if (bytes > CLASSIFY_IMAGE_LIMIT) return { ok: false, error: "imageDataUrl is too large" };
  const mediaType = match[1].toLowerCase() === "jpg" ? "image/jpeg" : `image/${match[1].toLowerCase()}`;
  return { ok: true, value: { kind: "image", mediaType: mediaType as Image["mediaType"], base64: match[2] } };
}

export function parseClassifyInput(value: unknown): GuardResult<ClassifyInput> {
  const body = record(value);
  if (!body) return { ok: false, error: "body must be an object" };
  const image = parseRasterImage(body.imageDataUrl);
  if (!image.ok) return image;

  const rawProjects = boundedArray(body.projects, "projects", PROJECT_LIMIT);
  if (!rawProjects.ok) return rawProjects;
  const projects: Project[] = [];
  for (const [index, item] of rawProjects.value.entries()) {
    const project = typeof item === "string" ? { name: item, description: "" } : record(item);
    if (!project) return { ok: false, error: `projects[${index}] is invalid` };
    const name = boundedString(project.name, `projects[${index}].name`, 120);
    const description = boundedString(project.description, `projects[${index}].description`, 500, { optional: true });
    if (!name.ok) return name;
    if (!description.ok) return description;
    projects.push({ name: name.value, description: description.value });
  }

  const rawCorrections = boundedArray(body.corrections, "corrections", CORRECTION_LIMIT);
  if (!rawCorrections.ok) return rawCorrections;
  const corrections: string[] = [];
  for (const [index, item] of rawCorrections.value.entries()) {
    const correction = boundedString(item, `corrections[${index}]`, 500);
    if (!correction.ok) return correction;
    corrections.push(correction.value);
  }

  const rawVocabulary = boundedArray(body.vocabulary, "vocabulary", VOCABULARY_LIMIT);
  if (!rawVocabulary.ok) return rawVocabulary;
  const vocabulary: string[] = [];
  for (const [index, item] of rawVocabulary.value.entries()) {
    const tag = boundedString(item, `vocabulary[${index}]`, 40);
    if (!tag.ok) return tag;
    vocabulary.push(tag.value);
  }

  const pageUrl = boundedString(body.pageUrl, "pageUrl", 2_048, { optional: true });
  const pageTitle = boundedString(body.pageTitle, "pageTitle", 500, { optional: true });
  if (!pageUrl.ok) return pageUrl;
  if (!pageTitle.ok) return pageTitle;

  return {
    ok: true,
    value: {
      image: image.value,
      projects,
      corrections,
      vocabulary,
      pageUrl: pageUrl.value || null,
      pageTitle: pageTitle.value || null,
    },
  };
}

export function parseChatInput(value: unknown): GuardResult<ChatInput> {
  const body = record(value);
  if (!body) return { ok: false, error: "body must be an object" };
  const question = boundedString(body.question, "question", 2_000);
  const project = boundedString(body.project ?? "Inbox", "project", 160);
  if (!question.ok) return question;
  if (!project.ok) return project;

  const rawCaptures = boundedArray(body.captures, "captures", CAPTURE_LIMIT);
  if (!rawCaptures.ok) return rawCaptures;
  const captures: ChatCapture[] = [];
  for (const [index, item] of rawCaptures.value.entries()) {
    const capture = record(item);
    if (!capture) return { ok: false, error: `captures[${index}] is invalid` };
    const id = boundedString(capture.id, `captures[${index}].id`, 128);
    const title = boundedString(capture.title, `captures[${index}].title`, 200);
    const summary = boundedString(capture.summary, `captures[${index}].summary`, 1_000, { optional: true });
    const ocrExcerpt = boundedString(capture.ocrExcerpt, `captures[${index}].ocrExcerpt`, 1_200, { optional: true });
    const intent = boundedString(capture.intent, `captures[${index}].intent`, 64);
    if (!id.ok) return id;
    if (!title.ok) return title;
    if (!summary.ok) return summary;
    if (!ocrExcerpt.ok) return ocrExcerpt;
    if (!intent.ok) return intent;
    captures.push({ id: id.value, title: title.value, summary: summary.value, ocrExcerpt: ocrExcerpt.value, intent: intent.value });
  }

  const rawHistory = boundedArray(body.history, "history", HISTORY_LIMIT);
  if (!rawHistory.ok) return rawHistory;
  const history: ChatInput["history"] = [];
  for (const [index, item] of rawHistory.value.entries()) {
    const message = record(item);
    if (!message || (message.role !== "user" && message.role !== "assistant")) {
      return { ok: false, error: `history[${index}].role is invalid` };
    }
    const text = boundedString(message.text, `history[${index}].text`, 2_000);
    if (!text.ok) return text;
    history.push({ role: message.role, text: text.value });
  }

  return { ok: true, value: { question: question.value, project: project.value, captures, history } };
}
