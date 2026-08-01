import type { Intent } from "@/lib/store";

/**
 * Human labels for the intent taxonomy (06 §3).
 *
 * These live here rather than in `components/ui.tsx` because `lib/retrieve.ts`
 * needs them — searching the label is what lets "mobile UI design" reach
 * `design_inspiration` — and a retriever that imports a React component module
 * cannot be exercised outside the browser. `ui.tsx` re-exports both names, so
 * every existing importer is unaffected.
 */
export const INTENT_LABEL: Record<Intent, string> = {
  design_inspiration: "Design inspiration",
  ux_bug: "UX bug",
  competitor: "Competitor",
  marketing_hook: "Marketing hook",
  content_idea: "Content idea",
  reference: "Reference",
  other: "Other",
};

export const INTENTS = Object.keys(INTENT_LABEL) as Intent[];
