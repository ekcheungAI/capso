import type { Screenshot } from "@/lib/store";

/**
 * Client-side stand-in for the per-capture AI pass. Returns the same 8-field
 * shape the real call must return (06_FEATURE_SPEC_AI_MEMORY.md), so Loop C
 * swaps the body for a POST to /api/classify and nothing else changes.
 */
export type Classification = Pick<
  Screenshot,
  "title" | "summary" | "whySaved" | "ocrText" | "intent" | "type" | "confidence"
> & { projectSuggestion: string | null };

const CANNED: Omit<Classification, "projectSuggestion">[] = [
  {
    title: "Pricing page with plan comparison",
    summary: "Three pricing tiers laid out in a comparison table with a highlighted middle plan.",
    whySaved: "Tier layout and the way the recommended plan is emphasised.",
    ocrText: "Starter\nPro — most popular\nEnterprise\nBilled monthly / annually",
    intent: "competitor",
    type: "web_page",
    confidence: 0.86,
  },
  {
    title: "Onboarding checklist screen",
    summary: "A first-run checklist with four steps and a progress indicator.",
    whySaved: "Checklist pacing — one action per row, progress always visible.",
    ocrText: "Get started\n1. Connect your account\n2. Import data\n3. Invite a teammate",
    intent: "design_inspiration",
    type: "ui_screen",
    confidence: 0.72,
  },
  {
    title: "Interface with layout glitch",
    summary: "A panel whose content overflows its container at this viewport width.",
    whySaved: "Looks like a spacing bug worth filing.",
    ocrText: "",
    intent: "ux_bug",
    type: "ui_screen",
    confidence: 0.44,
  },
];

/** Deterministic per-image so repeated runs of the demo behave predictably. */
export async function classify(
  dataUrl: string,
  threadIds: string[],
  delayMs = 2200,
): Promise<Classification> {
  await new Promise((r) => setTimeout(r, delayMs));

  const pick = CANNED[dataUrl.length % CANNED.length]!;
  const suggestion =
    pick.confidence >= 0.5 ? (threadIds[dataUrl.length % Math.max(threadIds.length, 1)] ?? null) : null;

  return { ...pick, projectSuggestion: suggestion };
}
