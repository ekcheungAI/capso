import { INTENT_LABEL } from "@/components/ui";
import type { Screenshot, Thread } from "@/lib/store";

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

export function retrieve(
  query: string,
  screenshots: Screenshot[],
  threads: Thread[],
  limit = 12,
): Scored[] {
  const words = terms(query);
  if (words.length === 0) return [];

  const threadName = (id: string | null) =>
    id === null ? "Inbox" : (threads.find((t) => t.id === id)?.name ?? "Inbox");

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
        const hay = text.toLowerCase();
        for (const w of words) {
          if (hay.includes(w)) {
            score += weight;
            hits.add(label);
          }
        }
      }

      // Recency nudge so equally-relevant results favour what you saved lately.
      const ageDays = (Date.now() - new Date(s.capturedAt).getTime()) / 864e5;
      score += Math.max(0, 2 - ageDays / 60);

      return { s, score, why: [...hits].slice(0, 2).join(" + ") };
    })
    .filter((x) => x.score > 2)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, limit);
}
