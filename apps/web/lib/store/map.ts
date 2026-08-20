// Relative and extensionful so this module runs under `node --experimental-strip-types`
// in map.check.ts — the same constraint retrieve.ts documents at its head.
import { aspectOf } from "@capso/shared/capture";
import type {
  AssignmentSource, Correction, Intent, Message, OcrSource, Revisit, Screenshot, Thread,
} from "./types.ts";

/**
 * The boundary between the client's `Screenshot` and the `screenshots` row.
 *
 * Four impedance mismatches live here and nowhere else — the point of the module
 * is that there is exactly one place for each of them to be wrong:
 *
 *   1. camelCase in TS, snake_case in Postgres.
 *   2. `status` uses different vocabularies on each side (see STATUS below).
 *   3. `archived` is a boolean in TS and a nullable timestamp on threads.
 *   4. `hue` and `aspect` are display-only and derived, never stored (10 §loop-24).
 *
 * `embedding` is deliberately absent in both directions: it lives in Postgres and
 * is never shipped to the client, per the note in types.ts.
 */

// ------------------------------------------------------------- status ----

/**
 * The client never shows a "queued" state — a capture is either being worked on,
 * finished, or gave up — so the DB's `pending` folds into `processing` on the way
 * out. Going the other way, `processing` is written rather than `pending`,
 * because by the time a row exists the classify call is already in flight.
 */
type DbStatus = "pending" | "processing" | "processed" | "unprocessed";

const toDbStatus = (s: Screenshot["status"]): DbStatus =>
  s === "done" ? "processed" : s;

const fromDbStatus = (s: DbStatus): Screenshot["status"] =>
  s === "processed" ? "done" : s === "pending" ? "processing" : s;

// --------------------------------------------------------- derivation ----

/**
 * The bucket a capture is rendered in, recomputed on read.
 *
 * Delegates to the shared spec rather than restating the thresholds: this used
 * to be a third copy of them, alongside the web capture path and the extension,
 * and a capture that bucketed one way when taken and another way when read back
 * would reflow the grid for no visible reason.
 *
 * Only the null-handling is local — a row with no dimensions (a seeded fixture)
 * has no ratio to bucket, and `wide` is the shape the placeholder draws.
 */
export function aspectFor(width: number | null, height: number | null): Screenshot["aspect"] {
  return width && height ? aspectOf(width, height) : "wide";
}

/**
 * A stable colour for the placeholder a capture draws when it has no image.
 * Hashed from the id rather than stored: a value derivable from its input is a
 * value that can disagree with its input.
 *
 * FNV-1a — small, well-distributed enough for picking a hue, and no dependency.
 */
export function hueFor(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return Math.abs(h) % 360;
}

/**
 * A stable uuid for a hand-written seed id.
 *
 * `seed.ts` uses readable ids — `"s1"`, `"pricing-redesign"` — and screenshots
 * reference their thread by that name. Postgres `uuid` columns reject them, but
 * rewriting the fixtures as literal uuids would cost the readability that makes
 * them reviewable, and every cross-reference with it.
 *
 * Derived rather than random so `loadSamples()` twice is idempotent instead of
 * duplicating the library, and so a screenshot's `threadId` still resolves to
 * the thread of the same name.
 *
 * Not RFC-4122 v5 (that needs SHA-1); it only has to be well-formed, stable and
 * collision-free across ~20 fixture names.
 */
export function uuidFromSeed(name: string): string {
  const bytes = new Uint8Array(16);
  let h = 0x811c9dc5;
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < name.length; j++) {
      h ^= name.charCodeAt(j) + i;
      h = Math.imul(h, 0x01000193);
    }
    bytes[i] = (h >>> 16) & 0xff;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC-4122 variant
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Materialise a readable screenshot fixture at the storage boundary.
 *
 * Both project references must move with the screenshot id. Mapping only the
 * confirmed `threadId` leaves pending sample suggestions pointing at names such
 * as `"onboarding-teardown"` while every stored thread has a UUID. The UI then
 * renders a convincing but false "Confirm - Inbox" action because it cannot
 * resolve the suggested project.
 */
export function screenshotWithSeedUuids(screenshot: Screenshot): Screenshot {
  return {
    ...screenshot,
    id: uuidFromSeed(screenshot.id),
    threadId: screenshot.threadId ? uuidFromSeed(screenshot.threadId) : null,
    suggestedThreadId: screenshot.suggestedThreadId
      ? uuidFromSeed(screenshot.suggestedThreadId)
      : null,
  };
}

// ---------------------------------------------------------- search text ----

/**
 * ICU segments Han/Kana/Thai with a dictionary regardless of locale tag, so one
 * segmenter covers English and 繁體中文 alike. Constructed once — construction is
 * the expensive part, `.segment()` is not. Mirrors lib/retrieve.ts.
 */
const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "word" })
    : null;

/**
 * What gets written to `search_text`, which the generated `search_tsv` column
 * tokenises with the `simple` config (10 §Amendment loop 12). Unsegmented, 定價
 * would never match a document containing 定價頁面.
 *
 * Deliberately *not* `retrieve.ts`'s `terms()`: that applies query-side filters —
 * stopwords, a Latin length minimum, dropping lone CJK characters — which are
 * right for a query and wrong for an index. Throwing a token away here makes it
 * permanently unfindable; keeping a weak one only costs a little index space.
 */
export function searchTextFor(s: Screenshot): string {
  const raw = [
    s.title, s.summary, s.whySaved, s.ocrText,
    s.tags.join(" "), s.userTags.join(" "),
    s.pageTitle ?? "", s.pageUrl ?? "",
  ].join(" ");

  if (!segmenter) return raw;

  const out: string[] = [];
  for (const { segment, isWordLike } of segmenter.segment(raw)) {
    if (isWordLike) out.push(segment);
  }
  // The raw text trails the tokens so English keeps the forms `simple` will not
  // stem — the same trade 10 §loop-12 accepted.
  return `${out.join(" ")} ${raw}`;
}

// -------------------------------------------------------- screenshots ----

export type ScreenshotRow = {
  id: string;
  user_id: string;
  project_thread_id: string | null;
  capture_kind: "screenshot" | "link" | "file";
  storage_path: string | null;
  thumb_path: string | null;
  width: number | null;
  height: number | null;
  source: string | null;
  source_app: string | null;
  page_url: string | null;
  page_title: string | null;
  processing_status: DbStatus;
  title: string;
  summary: string;
  why_saved: string;
  ocr_text: string;
  ocr_source: OcrSource | null;
  ocr_langs: string[];
  type: string | null;
  intent: Intent | null;
  tags: string[];
  user_tags: string[];
  confidence: number;
  suggested_thread_id: string | null;
  content_hash: string | null;
  simulated: boolean;
  assignment_source: AssignmentSource | null;
  archived: boolean;
  captured_at: string;
  search_text: string;
};

export function toRow(s: Screenshot, userId: string): ScreenshotRow {
  return {
    id: s.id,
    user_id: userId,
    project_thread_id: s.threadId,
    capture_kind: "screenshot",
    storage_path: s.originalPath,
    thumb_path: s.thumbPath,
    width: s.width,
    height: s.height,
    source: s.source,
    source_app: s.sourceApp,
    page_url: s.pageUrl,
    page_title: s.pageTitle,
    processing_status: toDbStatus(s.status),
    title: s.title,
    summary: s.summary,
    why_saved: s.whySaved,
    ocr_text: s.ocrText,
    ocr_source: s.ocrSource,
    ocr_langs: s.ocrLangs,
    type: s.type,
    intent: s.intent,
    tags: s.tags,
    user_tags: s.userTags,
    confidence: s.confidence,
    suggested_thread_id: s.suggestedThreadId,
    content_hash: s.contentHash,
    simulated: s.simulated,
    assignment_source: s.assignmentSource,
    archived: s.archived,
    captured_at: s.capturedAt,
    search_text: searchTextFor(s),
  };
}

/**
 * `imageDataUrl` and `thumbDataUrl` come back null: bytes live in Storage now,
 * and the store resolves display URLs separately. Callers already tolerate null
 * here — it is what every seeded fixture has always carried.
 */
export function fromRow(r: ScreenshotRow): Screenshot {
  return {
    id: r.id,
    title: r.title,
    summary: r.summary,
    whySaved: r.why_saved,
    ocrText: r.ocr_text,
    intent: (r.intent ?? "other") as Intent,
    type: (r.type ?? "other") as Screenshot["type"],
    threadId: r.project_thread_id,
    suggestedThreadId: r.suggested_thread_id,
    confidence: r.confidence,
    status: fromDbStatus(r.processing_status),
    simulated: r.simulated,
    assignmentSource: r.assignment_source,
    source: (r.source ?? "web_upload") as Screenshot["source"],
    capturedAt: r.captured_at,
    imageDataUrl: null,
    thumbDataUrl: null,
    width: r.width,
    height: r.height,
    hue: hueFor(r.id),
    aspect: aspectFor(r.width, r.height),
    archived: r.archived,
    pageUrl: r.page_url,
    pageTitle: r.page_title,
    sourceApp: r.source_app,
    tags: r.tags ?? [],
    userTags: r.user_tags ?? [],
    ocrSource: r.ocr_source,
    ocrLangs: r.ocr_langs ?? [],
    contentHash: r.content_hash,
    originalPath: r.storage_path,
    thumbPath: r.thumb_path,
  };
}

// ------------------------------------------------------------ threads ----

export type ThreadRow = {
  id: string;
  user_id: string;
  name: string;
  description: string;
  archived_at: string | null;
  created_at: string;
  last_active_at: string;
};

/**
 * `archived` is a boolean to the UI and a timestamp in the database. The
 * timestamp is the better record — it answers "when did this drop out of the
 * library" — so it is kept, and collapsed on the way out.
 */
export function threadToRow(t: Thread, userId: string): ThreadRow {
  return {
    id: t.id,
    user_id: userId,
    name: t.name,
    description: t.description,
    archived_at: t.archived ? t.lastActiveAt : null,
    created_at: t.createdAt,
    last_active_at: t.lastActiveAt,
  };
}

export function threadFromRow(r: ThreadRow): Thread {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? "",
    createdAt: r.created_at,
    lastActiveAt: r.last_active_at,
    archived: r.archived_at !== null,
  };
}

// ------------------------------------------- corrections, revisits, chat ----

export type CorrectionRow = {
  id: string;
  user_id: string;
  screenshot_id: string;
  field: Correction["field"];
  ai_value: string | null;
  user_value: string;
  was_ai_accepted: boolean;
  created_at: string;
};

export const correctionToRow = (c: Correction, userId: string): CorrectionRow => ({
  id: c.id,
  user_id: userId,
  screenshot_id: c.screenshotId,
  field: c.field,
  ai_value: c.aiValue,
  user_value: c.userValue,
  was_ai_accepted: c.wasAiAccepted,
  created_at: c.createdAt,
});

export const correctionFromRow = (r: CorrectionRow): Correction => ({
  id: r.id,
  screenshotId: r.screenshot_id,
  field: r.field,
  aiValue: r.ai_value,
  userValue: r.user_value,
  wasAiAccepted: r.was_ai_accepted,
  createdAt: r.created_at,
});

export type RevisitRow = {
  id: string;
  user_id: string;
  screenshot_id: string;
  kind: Revisit["kind"];
  created_at: string;
};

export const revisitToRow = (v: Revisit, userId: string): RevisitRow => ({
  id: v.id,
  user_id: userId,
  screenshot_id: v.screenshotId,
  kind: v.kind,
  created_at: v.createdAt,
});

export const revisitFromRow = (r: RevisitRow): Revisit => ({
  id: r.id,
  screenshotId: r.screenshot_id,
  kind: r.kind,
  createdAt: r.created_at,
});

export type MessageRow = {
  id: string;
  user_id: string;
  project_thread_id: string;
  role: Message["role"];
  content: string;
  cited_screenshot_ids: string[];
  created_at: string;
};

export const messageToRow = (m: Message, userId: string): MessageRow => ({
  id: m.id,
  user_id: userId,
  project_thread_id: m.threadId,
  role: m.role,
  content: m.text,
  cited_screenshot_ids: m.citedIds,
  created_at: m.createdAt,
});

export const messageFromRow = (r: MessageRow): Message => ({
  id: r.id,
  threadId: r.project_thread_id,
  role: r.role as Message["role"],
  text: r.content,
  citedIds: r.cited_screenshot_ids ?? [],
  createdAt: r.created_at,
});
