"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useStore } from "@/lib/store/provider";
import { getImage } from "@/lib/store";
import { ConfidenceBar, EmptyState, IntentChip, Thumb } from "@/components/ui";
import { useToast } from "@/components/toast";
import { classify, fewShotLines } from "@/lib/classify";

/**
 * Inbox triage — keyboard-first per 07: j/k navigate, ⏎ accepts the suggestion,
 * number keys pick a project. Three verbs only (Notion Mail): Confirm / Try again / Ignore.
 */
export default function InboxPage() {
  const { ready, inbox, threads, threadName, assign, patch, screenshots, corrections } = useStore();
  const [rerunning, setRerunning] = useState<string | null>(null);
  const toast = useToast();

  // Filing is one click, so it needs a receipt and a way back.
  const file = useCallback(
    async (s: (typeof inbox)[number], threadId: string | null) => {
      const previous = s.threadId;
      await assign(s, threadId, "inbox_triage");
      toast(`Filed to ${threadName(threadId)}`, () => void assign(s, previous, "manual"));
    },
    [assign, toast, threadName],
  );
  const [cursor, setCursor] = useState(0);

  const current = inbox[Math.min(cursor, inbox.length - 1)];

  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName))
        return;
      if (!current) return;

      if (e.key === "j") setCursor((c) => Math.min(c + 1, inbox.length - 1));
      if (e.key === "k") setCursor((c) => Math.max(c - 1, 0));
      if (e.key === "Enter" && current.suggestedThreadId) {
        void file(current, current.suggestedThreadId);
      }
      const n = Number(e.key);
      if (n >= 1 && n <= threads.length) {
        void file(current, threads[n - 1]!.id);
      }
    },
    [current, inbox.length, threads, file],
  );

  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey]);

  if (!ready) return <p className="text-xs text-muted">Loading…</p>;
  if (inbox.length === 0)
    return (
      <EmptyState
        title="Inbox is clear"
        body="Captures Capso was confident about went straight to their project. Anything uncertain waits here."
        action="Drop a screenshot anywhere to add one"
      />
    );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Inbox</h1>
        <p className="mt-1 text-xs text-muted">
          {inbox.length} need a decision. Anything above 80% confidence was filed automatically.{" "}
          <span className="text-[11px]">j/k move · ⏎ accept · 1–{threads.length} pick project</span>
        </p>
      </div>

      <ul className="space-y-3">
        {inbox.map((s, i) => (
          <li
            key={s.id}
            className={`flex gap-4 rounded-xl bg-surface p-3 ring-1 ${
              i === cursor ? "ring-2 ring-accent" : "ring-line"
            }`}
            onMouseEnter={() => setCursor(i)}
          >
            <Link href={`/s/${s.id}`} className="w-28 shrink-0">
              <Thumb s={s} />
            </Link>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/s/${s.id}`} className="truncate text-sm font-medium hover:text-accent">
                  {s.title}
                </Link>
                <IntentChip intent={s.intent} />
                {/* A confidence bar over a classification that never happened
                    reads as a model judgement. It is not one. */}
                {s.status === "unprocessed" ? (
                  <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-muted">
                    Couldn’t be read — try again
                  </span>
                ) : s.simulated ? (
                  <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-muted">
                    Sample data
                  </span>
                ) : (
                  <ConfidenceBar value={s.confidence} />
                )}
              </div>

              <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted">{s.summary}</p>
              <p className="mt-1 text-xs text-muted italic">{s.whySaved}</p>

              {s.suggestedThreadId && (
                <p className="mt-2 text-xs">
                  <span className="text-muted">Suggested — </span>
                  <span className="font-medium">{threadName(s.suggestedThreadId)}</span>
                </p>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => void file(s, s.suggestedThreadId)}
                  // With no suggestion, `threadName(null)` renders "Inbox" and
                  // Confirm assigns null → null: a visible no-op that still
                  // wrote a correction teaching the model to file into Inbox.
                  disabled={!s.suggestedThreadId}
                  className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink disabled:opacity-40"
                >
                  Confirm
                </button>

                <select
                  defaultValue=""
                  onChange={(e) => e.target.value && void file(s, e.target.value)}
                  className="rounded-md border border-line bg-surface px-2 py-1.5 text-xs"
                >
                  <option value="" disabled>
                    Change project…
                  </option>
                  {threads.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>

                <button
                  disabled={rerunning === s.id}
                  onClick={async () => {
                    setRerunning(s.id);
                    // Originals live in their own store now, so re-reading one
                    // is a fetch rather than a field access.
                    const full = s.imageDataUrl ?? (await getImage(s.id));
                    if (!full) {
                      setRerunning(null);
                      toast("Sample captures have no image to re-read.");
                      return;
                    }
                    const r = await classify(
                      full,
                      threads,
                      fewShotLines(corrections, screenshots, threads),
                      // Re-read with the same page context the capture arrived
                      // with, or the second guess is worse-informed than the first.
                      { pageUrl: s.pageUrl, pageTitle: s.pageTitle },
                    );
                    // A patch, so a re-read cannot clobber edits made while it
                    // ran — and so `status` actually moves. Without it, a
                    // capture stuck at "processing" stayed stuck: rendered as
                    // "Analysing…" forever, undraggable, invisible to /review.
                    await patch(s.id, {
                      title: r.title,
                      summary: r.summary,
                      whySaved: r.whySaved,
                      ocrText: r.ocrText,
                      intent: r.intent,
                      type: r.type,
                      confidence: r.confidence,
                      suggestedThreadId: r.projectSuggestion,
                      status: r.status,
                      simulated: r.simulated,
                      // `userTags` is untouched — a re-read must never discard
                      // tags the owner added by hand.
                      tags: r.tags,
                      ocrSource: r.ocrSource,
                      ocrLangs: r.ocrLangs,
                    });
                    setRerunning(null);
                    toast(r.simulated ? "Re-read with sample data" : "Re-read with MiniMax M3");
                  }}
                  className="rounded-md border border-line px-3 py-1.5 text-xs disabled:opacity-40"
                >
                  {rerunning === s.id ? "Reading…" : "Try again"}
                </button>
                <span className="text-[11px] text-muted">Ignoring leaves it here</span>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
