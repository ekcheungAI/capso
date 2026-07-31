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
  assignmentSource: AssignmentSource | null;
  source: "hotkey_region" | "hotkey_window" | "drag" | "clipboard" | "web_upload" | "extension" | "seed";
  capturedAt: string;
  /** Data URL of the real capture; null for seeded fixtures which draw a placeholder. */
  imageDataUrl: string | null;
  /** Deterministic placeholder seed for seeded fixtures. */
  hue: number;
  aspect: "tall" | "wide" | "square";
  archived: boolean;
};

export type Thread = {
  id: string;
  name: string;
  createdAt: string;
  lastActiveAt: string;
  archived: boolean;
};

/** Written on every attach/confirm — feeds the few-shot window (06 §6, 07:34). */
export type Correction = {
  id: string;
  screenshotId: string;
  field: "project" | "intent" | "why_saved";
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
