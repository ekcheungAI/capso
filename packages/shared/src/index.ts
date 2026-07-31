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
