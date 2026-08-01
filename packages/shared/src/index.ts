import { z } from "zod";

/** Locked taxonomy — see 10_DATA_MODEL.md. Only `screenshot` is implemented in v1. */
export const captureKind = z.enum(["screenshot", "link", "file"]);
export type CaptureKind = z.infer<typeof captureKind>;

/** Locked intent taxonomy — see 06_FEATURE_SPEC_AI_MEMORY.md. */
export const intent = z.enum([
  "design_inspiration",
  "ux_bug",
  "competitor",
  "marketing_hook",
  "content_idea",
  "reference",
  "other",
]);
export type Intent = z.infer<typeof intent>;

/** Confidence routing bands — see 09_AI_SYSTEM_AND_MODEL_ROUTING.md. */
export const AUTO_ASSIGN_MIN = 0.8;
export const SUGGEST_MIN = 0.5;

export function routeByConfidence(c: number): "auto" | "suggest" | "inbox" {
  if (c >= AUTO_ASSIGN_MIN) return "auto";
  if (c >= SUGGEST_MIN) return "suggest";
  return "inbox";
}

/** Capture type taxonomy — see 06_FEATURE_SPEC_AI_MEMORY.md §1. */
export const captureType = z.enum([
  "ui_screen",
  "web_page",
  "chat",
  "document",
  "chart",
  "code",
  "photo",
  "other",
]);
export type CaptureType = z.infer<typeof captureType>;

/**
 * The single per-capture AI response contract (06_FEATURE_SPEC_AI_MEMORY.md §1).
 * Shared so the server route and the client agree on one shape.
 */
export const classification = z.object({
  title: z.string().min(1).max(120),
  ocr_text: z.string(),
  summary: z.string().min(1),
  type: captureType,
  intent,
  project_suggestion: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  why_saved: z.string().max(200),
  /**
   * Concrete entity tags — brands, products, screen kinds, dominant colours,
   * language. Defaulted rather than required: a missing tag list is not worth
   * burning the one repair retry that exists to rescue genuinely broken JSON.
   */
  tags: z.array(z.string().min(1).max(40)).max(12).default([]),
});
export type Classification = z.infer<typeof classification>;
