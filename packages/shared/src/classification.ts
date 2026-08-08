import { z } from "zod";

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
 * The single per-capture AI response contract. Kept in a dependency-light
 * module so both Next.js and the Deno Edge worker validate the exact same shape.
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
  tags: z.array(z.string().min(1).max(40)).max(12).default([]),
});
export type Classification = z.infer<typeof classification>;
