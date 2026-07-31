import type { Correction, Screenshot, Thread } from "@/lib/store";

/**
 * Per-capture classification. Calls the real MiniMax pass via /api/classify and
 * falls back to canned output when no key is configured or the call fails —
 * a capture must never be lost because the model was unavailable (06 §fallback).
 */

export type Classification = Pick<
  Screenshot,
  "title" | "summary" | "whySaved" | "ocrText" | "intent" | "type" | "confidence"
> & { projectSuggestion: string | null; simulated: boolean };

const CANNED: Omit<Classification, "projectSuggestion" | "simulated">[] = [
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

/** Correction lines in the shape the prompt injects them (06 §6). */
export function fewShotLines(
  corrections: Correction[],
  screenshots: Screenshot[],
  threads: Thread[],
): string[] {
  const name = (id: string) => threads.find((t) => t.id === id)?.name ?? "Inbox";
  return corrections
    .filter((c) => c.field === "project")
    .slice(0, 20)
    .map((c) => {
      const shot = screenshots.find((s) => s.id === c.screenshotId);
      if (!shot) return null;
      return `Screenshot summarised as "${shot.summary}" → filed under "${name(c.userValue)}", intent "${shot.intent}".`;
    })
    .filter((x): x is string => x !== null);
}

export async function classify(
  imageDataUrl: string,
  threads: Thread[],
  corrections: string[] = [],
): Promise<Classification> {
  try {
    const res = await fetch("/api/classify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        imageDataUrl,
        projects: threads.map((t) => t.name),
        corrections,
      }),
    });

    if (res.ok) {
      const { result } = (await res.json()) as {
        result: {
          title: string;
          ocr_text: string;
          summary: string;
          type: Screenshot["type"];
          intent: Screenshot["intent"];
          project_suggestion: string | null;
          confidence: number;
          why_saved: string;
        };
      };

      // The model returns a project *name*; the store works in ids.
      const match = threads.find((t) => t.name === result.project_suggestion);

      return {
        title: result.title,
        summary: result.summary,
        whySaved: result.why_saved,
        ocrText: result.ocr_text,
        intent: result.intent,
        type: result.type,
        confidence: result.confidence,
        projectSuggestion: match?.id ?? null,
        simulated: false,
      };
    }
  } catch {
    // network/parse failure — fall through to simulated
  }

  return simulated(imageDataUrl, threads);
}

async function simulated(imageDataUrl: string, threads: Thread[]): Promise<Classification> {
  await new Promise((r) => setTimeout(r, 1400));
  const pick = CANNED[imageDataUrl.length % CANNED.length]!;
  const suggestion =
    pick.confidence >= 0.5 && threads.length > 0
      ? (threads[imageDataUrl.length % threads.length]?.id ?? null)
      : null;
  return { ...pick, projectSuggestion: suggestion, simulated: true };
}
