/** Shapes mirror 10_DATA_MODEL.md so the P1 Supabase swap is a data-layer change only. */

export type Intent =
  | "design_inspiration"
  | "ux_bug"
  | "competitor"
  | "marketing_hook"
  | "content_idea"
  | "reference"
  | "other";

export type CaptureType =
  | "ui_screen"
  | "web_page"
  | "chat"
  | "document"
  | "chart"
  | "code"
  | "photo"
  | "other";

/** processing → done, or failed after retries (06: surfaced as "unprocessed"). */
export type Status = "processing" | "done" | "unprocessed";

export type AssignmentSource = "auto" | "user_corrected" | "inbox_triage" | "manual";

/**
 * Where `ocrText` came from. Reserved by 06 §2 from day one precisely so moving
 * off LLM transcription is a non-breaking change.
 */
export type OcrSource = "llm" | "tesseract" | "apple_vision";

export type Screenshot = {
  id: string;
  title: string;
  summary: string;
  whySaved: string;
  ocrText: string;
  intent: Intent;
  type: CaptureType;
  threadId: string | null;
  suggestedThreadId: string | null;
  confidence: number;
  status: Status;
  /**
   * True when the metadata came from canned demo output rather than the model —
   * i.e. no API key was configured. Persisted rather than inferred, because the
   * flag used to live only in memory: a demo capture was indistinguishable from
   * a real one the moment it was written, and its invented `ocrText` went
   * straight into the search index.
   */
  simulated: boolean;
  assignmentSource: AssignmentSource | null;
  source: "hotkey_region" | "hotkey_window" | "hotkey_fullscreen" | "drag" | "clipboard" | "web_upload" | "extension" | "seed";
  capturedAt: string;
  /** Data URL of the real capture; null for seeded fixtures which draw a placeholder. */
  imageDataUrl: string | null;
  /**
   * 800px WebP variant (doc 14 §25). Every grid, sidebar, filmstrip and citation
   * renders this; only the detail hero, zoom, copy and download touch the
   * original. Null on rows written before thumbs existed — `imageFor` falls back
   * to the full image, so old captures degrade to the previous behaviour rather
   * than breaking.
   */
  thumbDataUrl: string | null;
  /**
   * True pixel size of the stored original. `aspect` keeps only three buckets,
   * which is not enough to reserve layout space and stop the grid shifting as
   * images decode.
   */
  width: number | null;
  height: number | null;
  /** Deterministic placeholder seed for seeded fixtures. */
  hue: number;
  aspect: "tall" | "wide" | "square";
  archived: boolean;

  // ---- Capture context ----------------------------------------------------
  /**
   * The page a browser capture came from. The extension has always sent these;
   * until now nothing read them. They are the highest-signal metadata a tab
   * capture can offer — both for classification and for search.
   */
  pageUrl: string | null;
  pageTitle: string | null;
  /** Frontmost app, recorded opportunistically on window captures (08 §4). */
  sourceApp: string | null;

  // ---- Tagging ------------------------------------------------------------
  /**
   * AI-proposed entity tags. Kept strictly separate from `userTags` so "AI
   * suggests, user confirms" survives contact with the data: removing one is a
   * correction, and the ledger in /memory can show it back.
   */
  tags: string[];
  /** Tags the owner added. Never written by the model. */
  userTags: string[];

  // ---- OCR ----------------------------------------------------------------
  ocrSource: OcrSource | null;
  /** BCP-47-ish hints from the OCR pass; drives which analyzer runs. */
  ocrLangs: string[];

  // ---- Storage ------------------------------------------------------------
  /**
   * Exact-duplicate detection at ingest. Replaces the O(n²) title-word
   * heuristic that /memory currently calls "possible duplicates".
   */
  contentHash: string | null;
  /**
   * Supabase Storage object paths (buckets `originals` / `thumbs`, per doc 14).
   * Null while the demo still inlines base64 in `imageDataUrl`. Grids read
   * `thumbPath`; only the detail view touches `originalPath`.
   */
  originalPath: string | null;
  thumbPath: string | null;
};

/**
 * Rows written before a field existed read back without it. Every read path goes
 * through here so `s.tags.map(...)` cannot explode on a library captured last
 * week — the same guard `withDescription` already provides for threads.
 *
 * `embedding` is deliberately absent from this type: it lives in Postgres and is
 * never shipped to the client. Carrying ~1.5k floats per row into React state
 * would undo the entire point of moving off IndexedDB.
 */
export function withScreenshotDefaults(s: Screenshot): Screenshot {
  return {
    ...s,
    simulated: s.simulated ?? false,
    thumbDataUrl: s.thumbDataUrl ?? null,
    width: s.width ?? null,
    height: s.height ?? null,
    pageUrl: s.pageUrl ?? null,
    pageTitle: s.pageTitle ?? null,
    sourceApp: s.sourceApp ?? null,
    tags: s.tags ?? [],
    userTags: s.userTags ?? [],
    ocrSource: s.ocrSource ?? null,
    ocrLangs: s.ocrLangs ?? [],
    contentHash: s.contentHash ?? null,
    originalPath: s.originalPath ?? null,
    thumbPath: s.thumbPath ?? null,
  };
}

export type Thread = {
  id: string;
  name: string;
  /**
   * One plain-English line about what belongs here. Doubles as the classifier's
   * candidate context (10_DATA_MODEL: "fed into W1 candidate list") — a bare
   * name makes the model guess from a label.
   */
  description: string;
  createdAt: string;
  lastActiveAt: string;
  archived: boolean;
};

/** Written on every attach/confirm — feeds the few-shot window (06 §6, 07:34). */
export type Correction = {
  id: string;
  screenshotId: string;
  field: "project" | "intent" | "why_saved" | "tags";
  aiValue: string | null;
  userValue: string;
  wasAiAccepted: boolean;
  createdAt: string;
};

export type Revisit = {
  id: string;
  screenshotId: string;
  kind: "opened_detail" | "referenced_in_chat" | "copied" | "search_clicked";
  createdAt: string;
};

/** Chat turns, scoped to a thread. `citedIds` is what the answer claims to have read. */
export type Message = {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  text: string;
  citedIds: string[];
  createdAt: string;
};
