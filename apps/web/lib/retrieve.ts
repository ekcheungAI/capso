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

export function terms(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2 && !STOP.has(w));
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
        [s.whySaved, 3, "your note"],
        [s.summary, 3, "summary"],
        [INTENT_LABEL[s.intent], 3, "intent"],
        [threadName(s.threadId), 2, "project"],
        [s.ocrText, 2, "text in image"],
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
