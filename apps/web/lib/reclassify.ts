"use client";

import { useCallback, useState } from "react";
import { getImage, type Screenshot } from "@/lib/store";
import { useStore } from "@/lib/store/provider";
import { useToast } from "@/components/toast";
import { classify, fewShotLines } from "@/lib/classify";
import { tagVocabulary } from "@/lib/tags";

/**
 * Read a capture again.
 *
 * This lived inline in the Inbox, which made the Inbox the only place a failed
 * classification could be recovered from. A capture that failed and was then
 * filed — dragged onto a project, or moved from its card — left the Inbox and
 * took its only retry button with it: permanently titleless, summaryless, with
 * no OCR text and no way back short of deleting it and capturing again. The
 * detail view, which is where anyone reading "Couldn't read this one" actually
 * goes, had no way to act on it at all.
 */
export function useReclassify() {
  const { threads, screenshots, corrections, patch } = useStore();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const reread = useCallback(
    async (s: Screenshot) => {
      setBusy(s.id);
      try {
        // Originals live in their own store now, so re-reading one is a fetch
        // rather than a field access.
        const full = s.imageDataUrl ?? (await getImage(s.id));
        if (!full) {
          toast("Sample captures have no image to re-read.");
          return;
        }

        const r = await classify(
          full,
          threads,
          fewShotLines(corrections, screenshots, threads),
          // Re-read with the same page context the capture arrived with, or the
          // second guess is worse-informed than the first.
          { pageUrl: s.pageUrl, pageTitle: s.pageTitle },
          tagVocabulary(screenshots),
        );

        // A patch, so a re-read cannot clobber edits made while it ran — and so
        // `status` actually moves. Without it, a capture stuck at "processing"
        // stayed stuck: rendered as "Analysing…" forever, undraggable, and
        // invisible to /review.
        await patch(s.id, (current) => ({
          title: r.title,
          summary: r.summary,
          ocrText: r.ocrText,
          intent: r.intent,
          type: r.type,
          confidence: r.confidence,
          suggestedThreadId: r.projectSuggestion,
          status: r.status,
          simulated: r.simulated,
          // `userTags` is untouched — a re-read must never discard tags the
          // owner added by hand. `whySaved` likewise: it is the model's guess
          // but the user's to write, so a re-read must not overwrite one they
          // already typed.
          tags: r.tags,
          ocrSource: r.ocrSource,
          ocrLangs: r.ocrLangs,
          ...(current.whySaved ? {} : { whySaved: r.whySaved }),
        }));

        toast(
          r.status === "unprocessed"
            ? "Still couldn't read it — the model returned nothing usable."
            : r.simulated
              ? "Re-read with sample data"
              : "Re-read with MiniMax M3",
        );
      } finally {
        setBusy(null);
      }
    },
    [threads, screenshots, corrections, patch, toast],
  );

  return { reread, busy };
}
