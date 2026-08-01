// Relative and extensionful so `retrieve.check.ts` can run this module under
// plain node; every other import here is type-only and erases at runtime.
import { INTENT_LABEL } from "./intent.ts";
import type { Revisit, Screenshot, Thread } from "@/lib/store";

/**
 * Local hybrid retrieval. Scores term overlap across every field the user could
 * plausibly remember — title, summary, their own why_saved note, OCR text, and
 * the human label of the intent so "mobile UI design" reaches design_inspiration.
 *
 * P1 replaces the body with pgvector + tsvector; the signature stays.
 */

const STOP = new Set([
  "what","some","good","have","this","that","with","from","they","them","then","than","when","which",
  "were","been","into","your","yours","about","would","could","should","there","their","these","those",
  "made","make","put","together","for","the","and","are","was","did","does","how","any","all","i've",
]);

/** Han, Hiragana, Katakana, Hangul — scripts that do not delimit words with spaces. */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * ICU segments Han/Kana/Thai with a dictionary regardless of the locale tag, so
 * one segmenter handles English and 繁體中文 alike. Created once — construction
 * is the expensive part, `.segment()` is not.
 */
const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "word" })
    : null;

const NUMERIC = /^\p{N}+$/u;

/**
 * A query's searchable terms.
 *
 * Three rules, each earning its keep:
 *
 * - The `length > 2` minimum is **Latin-only**. 定價 is two characters and a
 *   whole word, so applying it globally silently dropped every Chinese query
 *   even though the classifier is told to preserve Traditional Chinese verbatim.
 * - Single-character CJK segments are dropped when longer ones exist — 頁 and 面
 *   match almost any Chinese text and would drown the real signal — but kept if
 *   they are all we have, so a one-character query still returns something.
 * - Numbers survive at any length. Prices, percentages and error codes are
 *   precisely the exact-match recall that keyword search exists for (08 §3), and
 *   `length > 2` was quietly eating "68%" and "$29".
 *
 * The same segmentation feeds the tsvector column at write time, because hosted
 * Supabase has no `zhparser` — we segment in JS and index with `simple`.
 */
export function terms(q: string): string[] {
  const lower = q.toLowerCase();

  const raw: string[] = [];
  if (segmenter) {
    for (const { segment, isWordLike } of segmenter.segment(lower)) {
      if (isWordLike) raw.push(segment);
    }
  } else {
    // Pre-Segmenter runtimes: keep CJK runs whole rather than losing them.
    raw.push(...lower.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  }

  const cjk = raw.filter((w) => CJK.test(w));
  const multi = cjk.filter((w) => w.length > 1);
  const keepCjk = new Set(multi.length > 0 ? multi : cjk);

  return raw.filter((w) =>
    CJK.test(w) ? keepCjk.has(w) : NUMERIC.test(w) || (w.length > 2 && !STOP.has(w)),
  );
}

export type Scored = { s: Screenshot; score: number; why: string };

/** Escape a term so it can sit inside a RegExp literal. */
const escapeRe = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * One matcher per query term, built once per query rather than once per field.
 *
 * Latin terms must match at the *start* of a word. `includes` scored "cat"
 * against "duplicate" and "design" against "redesigned", which is how a query
 * for one thing surfaced an unrelated capture with a long OCR blob. Matching a
 * prefix rather than a whole word is deliberate and is the cheapest stand-in
 * for stemming we can have before the tsvector column exists: "design" still
 * reaches "designs" and "designer".
 *
 * CJK terms keep substring matching. The scripts do not delimit words, so
 * there is no boundary to anchor to between two Han characters.
 */
function matcher(word: string): (hay: string) => boolean {
  if (CJK.test(word)) return (hay) => hay.includes(word);
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(word)}`, "u");
  return (hay) => re.test(hay);
}

/**
 * Ceilings for the two behavioural signals, kept well under the field weights
 * below so they order ties rather than decide matches. 08 §5 weights the full
 * hybrid ranker 0.25 keyword / 0.10 recency / 0.10 revisit; until the semantic
 * half exists this is the keyword stage carrying those two nudges at roughly
 * the same ratio to each other.
 */
const RECENCY_MAX = 2;
const REVISIT_MAX = 2;
/** Revisits beyond this stop adding signal — a capture opened 40 times is not 4× one opened 10 times. */
const REVISIT_SATURATION = 8;

export function retrieve(
  query: string,
  screenshots: Screenshot[],
  threads: Thread[],
  limit = 12,
  revisits: Revisit[] = [],
): Scored[] {
  const words = terms(query);
  if (words.length === 0) return [];

  const matchers = words.map(matcher);

  const threadName = (id: string | null) =>
    id === null ? "Inbox" : (threads.find((t) => t.id === id)?.name ?? "Inbox");

  // Captures you keep coming back to should win ties — 08 §5 specifies a
  // revisit term and the events have been recorded since Loop 03 with no
  // consumer. Counted once per query, not once per capture.
  const revisitCount = new Map<string, number>();
  for (const r of revisits) {
    revisitCount.set(r.screenshotId, (revisitCount.get(r.screenshotId) ?? 0) + 1);
  }

  const scored = screenshots
    .filter((s) => !s.archived)
    .map((s) => {
      const fields: [string, number, string][] = [
        [s.title, 4, "title"],
        // Tags the owner added outrank tags the model guessed — a hand-typed
        // tag is the strongest statement of intent in the whole row.
        [s.userTags.join(" "), 4, "your tags"],
        [s.whySaved, 3, "your note"],
        [s.summary, 3, "summary"],
        [s.tags.join(" "), 3, "tags"],
        [INTENT_LABEL[s.intent], 3, "intent"],
        [s.pageTitle ?? "", 3, "page title"],
        [threadName(s.threadId), 2, "project"],
        [s.ocrText, 2, "text in image"],
        [s.pageUrl ?? "", 1, "page url"],
      ];

      let score = 0;
      const hits = new Set<string>();
      for (const [text, weight, label] of fields) {
        if (!text) continue;
        const hay = text.toLowerCase();
        let matched = 0;
        for (const m of matchers) if (m(hay)) matched++;
        if (matched === 0) continue;
        // A field contributes at most its own weight, scaled by how much of the
        // query it covers. Adding `weight` per matching word meant a verbose
        // query could score one field several times over and let a single long
        // OCR blob outrank an exact title match.
        score += weight * (matched / words.length);
        hits.add(label);
      }

      // Nothing in the query appears anywhere in this capture. The old cutoff
      // was `score > 2`, numerically identical to the maximum recency bonus, so
      // it excluded non-matches only by coincidence and would have started
      // leaking them the moment either constant moved.
      if (hits.size === 0) return null;

      const ageDays = (Date.now() - new Date(s.capturedAt).getTime()) / 864e5;
      score += RECENCY_MAX * Math.exp(-ageDays / 90);
      score +=
        REVISIT_MAX *
        Math.min(1, Math.log1p(revisitCount.get(s.id) ?? 0) / Math.log1p(REVISIT_SATURATION));

      return { s, score, why: [...hits].slice(0, 2).join(" + ") };
    })
    .filter((x): x is Scored => x !== null)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, limit);
}
