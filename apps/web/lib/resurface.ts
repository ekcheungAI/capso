import type { Revisit, Screenshot } from "@/lib/store";

/**
 * Which captures are worth bringing back today, and — the part that is not
 * optional — why.
 *
 * `drafts/brand/GUIDELINES.html`: "Resurfaced captures state their reason. A
 * recommendation the user cannot interrogate is one they can neither trust nor
 * dismiss." So this returns a reason string per capture rather than a bare list,
 * and there is no code path that produces a candidate without one.
 *
 * The shelf is meant to be empty most days, which is why nothing younger than
 * MIN_AGE_DAYS is eligible: a capture you saved this morning has not been
 * forgotten yet, and a shelf that is always full is a backlog, not a memory.
 */

/** Below this, a capture is simply recent — not forgotten. */
const MIN_AGE_DAYS = 14;

export type Resurfaced = { s: Screenshot; reason: string };

const monthOf = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { month: "long", year: "numeric" });

/**
 * First rule that fits wins, most specific first. Every branch names something
 * true about this capture — never "recommended for you", which explains nothing
 * and cannot be argued with.
 */
function reasonFor(s: Screenshot, projectName: string): string {
  if (s.assignmentSource === "auto" && s.threadId !== null)
    return `Capso seated this in ${projectName} and you have never opened it.`;
  if (s.whySaved.trim())
    return `You wrote “${s.whySaved.trim().slice(0, 60)}” and never came back to it.`;
  if (s.threadId === null) return `Saved ${monthOf(s.capturedAt)}, still without a project.`;
  return `Saved ${monthOf(s.capturedAt)}, never opened since.`;
}

export function resurface(
  screenshots: Screenshot[],
  revisits: Revisit[],
  threadName: (id: string | null) => string,
  limit = 3,
  now = Date.now(),
): Resurfaced[] {
  const seen = new Set(revisits.map((r) => r.screenshotId));

  return screenshots
    .filter((s) => {
      if (s.archived || seen.has(s.id)) return false;
      // A capture whose classification failed has no summary and no OCR text —
      // resurfacing it would be showing the user an unreadable card and calling
      // it a suggestion.
      if (s.status !== "done") return false;
      const ageDays = (now - new Date(s.capturedAt).getTime()) / 864e5;
      return ageDays >= MIN_AGE_DAYS;
    })
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
    .slice(0, limit)
    .map((s) => ({ s, reason: reasonFor(s, threadName(s.threadId)) }));
}
