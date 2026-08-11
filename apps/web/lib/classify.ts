import type { Correction, Screenshot, Thread } from "@/lib/store";
import { accountFetch } from "@/lib/supabase/client";

/**
 * Per-capture classification. Calls the real MiniMax pass via /api/classify.
 *
 * Two very different non-success paths, which this file used to conflate:
 *
 * - **No key configured** (503) is a deliberate demo mode. Canned output is fine
 *   there, because the user has opted into it and the sidebar says so — but the
 *   row is marked `simulated` so nothing downstream mistakes it for real.
 * - **A genuine failure** (502, network, unparseable) must produce *nothing*.
 *   It used to fall into the same canned branch, which meant a real screenshot
 *   got a fabricated title, fabricated tags and **fabricated `ocrText`** picked
 *   by `imageDataUrl.length % 3`, at a confidence high enough to auto-file it
 *   into a randomly chosen project. That invented text was then indexed by
 *   search and quoted back by chat as fact.
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
  | "status"
  | "simulated"
> & { projectSuggestion: string | null };

/** Give up rather than invent. The capture is kept; the metadata is not faked. */
function failed(): Classification {
  return {
    title: "Couldn’t read this one",
    summary: "",
    whySaved: "",
    ocrText: "",
    intent: "other",
    type: "other",
    // Zero, so `routeConfidence` can never auto-file a capture the model never
    // actually saw.
    confidence: 0,
    projectSuggestion: null,
    tags: [],
    ocrSource: null,
    ocrLangs: [],
    status: "unprocessed",
    simulated: false,
  };
}

/** Page context a browser capture can supply; absent for files and pastes. */
export type CaptureContext = { pageUrl?: string | null; pageTitle?: string | null };

/**
 * The route allows 60s (`maxDuration`). This sits just past it so a request the
 * server has genuinely abandoned cannot leave the client waiting forever.
 */
const CLASSIFY_TIMEOUT_MS = 65_000;

const CANNED: Omit<
  Classification,
  "projectSuggestion" | "simulated" | "ocrSource" | "ocrLangs" | "status"
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
  /**
   * Tags the library already uses. Without this the model coins a near-synonym
   * per capture and the tag axis fragments into facets of one — see lib/tags.ts.
   */
  vocabulary: string[] = [],
): Promise<Classification> {
  // A hung connection used to park the row at `status: "processing"` forever,
  // with no recovery except deleting the capture.
  const abort = AbortSignal.timeout(CLASSIFY_TIMEOUT_MS);

  try {
    const res = await accountFetch("/api/classify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: abort,
      body: JSON.stringify({
        imageDataUrl,
        // Descriptions travel with the names: "Hooks & copy swipe file" alone
        // tells the model nothing, the line under it tells it everything.
        projects: threads.map((t) => ({ name: t.name, description: t.description })),
        corrections,
        vocabulary,
        pageUrl: context.pageUrl ?? null,
        pageTitle: context.pageTitle ?? null,
      }),
    });

    // 503 means the key is not configured — a deliberate demo mode, not a
    // failure. Every other non-OK status is a real failure and must not invent.
    if (res.status === 503) return simulated(imageDataUrl, threads);
    if (!res.ok) return failed();

    {
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
        status: "done",
        tags: normaliseTags(result.tags),
        // Honest provenance: the text came out of the vision model, not an OCR
        // engine. When tesseract runs at ingest this becomes "tesseract" and the
        // model stops being asked to transcribe at all.
        ocrSource: "llm",
        ocrLangs: [],
      };
    }
  } catch {
    // Network error, abort timeout, or an unparseable body. All genuine
    // failures — the capture is kept, the metadata is not invented.
  }

  return failed();
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
  // Eight was right when tags were decoration on the detail page. They are the
  // navigation axis now, and a capture that earns a subject, a surface and a
  // brand tag should not lose the fourth angle to a cap set for a sidebar list.
  return [...seen].slice(0, 12);
}

/**
 * Demo mode, reached only when the server reports no key configured. The canned
 * text is deliberate here — it lets the whole flow be demonstrated — but the row
 * is flagged `simulated` so the card, the Inbox and anything downstream can say
 * so. Nothing about it is allowed to look like a real classification.
 */
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
    status: "done",
    ocrSource: null,
    ocrLangs: [],
  };
}
