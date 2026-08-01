import type { Screenshot } from "@/lib/store";

/**
 * Tags as a navigable axis.
 *
 * A project is a destination: one per capture, mutually exclusive, and it has to
 * exist before anything can go in it. That exclusivity is what produces a filing
 * decision, and the decision is what produces the Inbox backlog. A tag is a
 * facet — many per capture, nothing displaced by adding one, so being wrong
 * costs nothing and there is no queue.
 *
 * Both already exist on every row. Only one of them was ever navigable.
 */

/** Owner tags first: a hand-typed tag outranks a guessed one everywhere else too. */
export function allTags(s: Screenshot): string[] {
  return [...new Set([...s.userTags, ...s.tags])];
}

/**
 * Every tag in the library with its frequency, most-used first.
 *
 * Ties break alphabetically rather than by insertion order, so the sidebar does
 * not reshuffle itself between renders for no visible reason.
 */
export function tagCounts(screenshots: Screenshot[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const s of screenshots) {
    if (s.archived) continue;
    for (const t of allTags(s)) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * The tags the classifier should reuse rather than reinvent.
 *
 * This is the whole reason tag navigation can work at all. Left to itself the
 * model writes "pricing", "pricing page" and "pricing table" for three captures
 * of the same thing, and a tag filter over that is worse than no filter —
 * every facet holds one item and none of them is the one you want. Feeding the
 * existing vocabulary back in is the same mechanism the correction ledger
 * already uses for projects (06 §6), applied to the axis that had none.
 *
 * Singletons are excluded: a tag used once is not yet vocabulary, and offering
 * it as one would cement whatever the model happened to say the first time.
 */
export function tagVocabulary(screenshots: Screenshot[], limit = 40): string[] {
  return tagCounts(screenshots)
    .filter(([, n]) => n > 1)
    .slice(0, limit)
    .map(([tag]) => tag);
}
