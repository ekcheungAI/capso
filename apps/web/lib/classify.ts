import type { Correction, Screenshot, Thread } from "@/lib/store";

/**
 * Per-capture classification. Calls the real MiniMax pass via /api/classify and
 * falls back to canned output when no key is configured or the call fails —
 * a capture must never be lost because the model was unavailable (06 §fallback).
 */

export type Classification = Pick<
  Screenshot,
  | "title"
  | "summary"
  | "whySaved"
  | "ocrText"
  | "intent"
  | "type"
  | "confidence"
  | "tags"
  | "ocrSource"
  | "ocrLangs"
> & { projectSuggestion: string | null; simulated: boolean };

/** Page context a browser capture can supply; absent for files and pastes. */
export type CaptureContext = { pageUrl?: string | null; pageTitle?: string | null };

const CANNED: Omit<
  Classification,
  "projectSuggestion" | "simulated" | "ocrSource" | "ocrLangs"
>[] = [
  {
    title: "Pricing page with plan comparison",
    summary: "Three pricing tiers laid out in a comparison table with a highlighted middle plan.",
    whySaved: "Tier layout and the way the recommended plan is emphasised.",
    ocrText: "Starter\nPro — most popular\nEnterprise\nBilled monthly / annually",
    intent: "competitor",
    type: "web_page",
    confidence: 0.86,
    tags: ["pricing table", "three tiers", "annual billing"],
  },
  {
    title: "Onboarding checklist screen",
    summary: "A first-run checklist with four steps and a progress indicator.",
    whySaved: "Checklist pacing — one action per row, progress always visible.",
    ocrText: "Get started\n1. Connect your account\n2. Import data\n3. Invite a teammate",
    intent: "design_inspiration",
    type: "ui_screen",
    confidence: 0.72,
    tags: ["onboarding checklist", "progress indicator", "empty state"],
  },
  {
    title: "Interface with layout glitch",
    summary: "A panel whose content overflows its container at this viewport width.",
    whySaved: "Looks like a spacing bug worth filing.",
    ocrText: "",
    intent: "ux_bug",
    type: "ui_screen",
    confidence: 0.44,
    tags: ["overflow", "layout bug"],
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
  context: CaptureContext = {},
): Promise<Classification> {
  try {
    const res = await fetch("/api/classify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        imageDataUrl,
        // Descriptions travel with the names: "Hooks & copy swipe file" alone
        // tells the model nothing, the line under it tells it everything.
        projects: threads.map((t) => ({ name: t.name, description: t.description })),
        corrections,
        pageUrl: context.pageUrl ?? null,
        pageTitle: context.pageTitle ?? null,
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
          tags: string[];
        };
      };

      // The model returns a project *name*; the store works in ids.
      const match = matchThread(threads, result.project_suggestion);

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
        tags: normaliseTags(result.tags),
        // Honest provenance: the text came out of the vision model, not an OCR
        // engine. When tesseract runs at ingest this becomes "tesseract" and the
        // model stops being asked to transcribe at all.
        ocrSource: "llm",
        ocrLangs: [],
      };
    }
  } catch {
    // network/parse failure — fall through to simulated
  }

  return simulated(imageDataUrl, threads);
}

/**
 * Fold a project name to a comparison key. Models reproduce a name from the
 * candidate list *almost* exactly and then drift on the parts that carry no
 * meaning — an ampersand spelled out, an em-dash normalised to a hyphen, a
 * doubled space, different casing.
 */
function nameKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Last-resort key: drop the connectives too, so "Marketing & hooks" and a model
 * that wrote "Marketing—hooks" land on the same string. Only used when exactly
 * one candidate matches, because this is loose enough to collide.
 */
function loosestKey(s: string): string {
  return nameKey(s)
    .split(" ")
    .filter((w) => w !== "and" && w !== "the")
    .join(" ");
}

/**
 * Resolve the model's project name to a thread.
 *
 * This used to be `threads.find((t) => t.name === result.project_suggestion)`.
 * Exact string equality meant "Hooks & copy swipe file" vs "Hooks and copy
 * swipe file" resolved to null — and a null suggestion does not merely lose the
 * auto-file, it strips `suggestedThreadId` too, so the capture lands in the
 * Inbox with no suggestion and is counted by no shelf. The failure was total,
 * silent, and indistinguishable from the model genuinely not knowing.
 */
export function matchThread(threads: Thread[], name: string | null): Thread | undefined {
  if (!name) return undefined;

  const exact = threads.find((t) => t.name === name);
  if (exact) return exact;

  const key = nameKey(name);
  let hit = threads.find((t) => nameKey(t.name) === key);

  if (!hit) {
    const loosest = loosestKey(name);
    const candidates = threads.filter((t) => loosestKey(t.name) === loosest);
    // Ambiguity here means guessing, and a wrong auto-file is worse than an
    // honest "unsorted" — so only take it when the answer is unique.
    if (candidates.length === 1) hit = candidates[0];
  }

  // Worth knowing about: it means the prompt's "copied exactly" rule is not
  // holding, and every near-miss this does not catch is an unfiled capture.
  console.info(
    hit
      ? `[capso] project name matched loosely: model said "${name}", filed as "${hit.name}"`
      : `[capso] project name matched no candidate: model said "${name}"`,
  );

  return hit;
}

/**
 * Models drift from any tag format you give them. Trim, lowercase, drop empties
 * and duplicates, cap the list — cheaper and more reliable than another retry.
 */
function normaliseTags(tags: string[] | undefined): string[] {
  const seen = new Set<string>();
  for (const t of tags ?? []) {
    const clean = t.trim().toLowerCase().replace(/^#/, "").slice(0, 40);
    if (clean) seen.add(clean);
  }
  return [...seen].slice(0, 8);
}

async function simulated(imageDataUrl: string, threads: Thread[]): Promise<Classification> {
  await new Promise((r) => setTimeout(r, 1400));
  const pick = CANNED[imageDataUrl.length % CANNED.length]!;
  const suggestion =
    pick.confidence >= 0.5 && threads.length > 0
      ? (threads[imageDataUrl.length % threads.length]?.id ?? null)
      : null;
  return {
    ...pick,
    projectSuggestion: suggestion,
    simulated: true,
    ocrSource: null,
    ocrLangs: [],
  };
}
