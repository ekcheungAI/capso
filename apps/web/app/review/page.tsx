"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useStore } from "@/lib/store/provider";
import { useToast } from "@/components/toast";
import { ConfidenceBar, EmptyState, IntentChip, SkeletonGrid, Thumb } from "@/components/ui";

/**
 * The review sweep.
 *
 * A fresh library has no correction history, so the classifier has nothing to
 * learn from and its guesses cluster in the "ask the user" band — an import of
 * nine screenshots produced nine decisions and no filing. That is the cold start
 * described in 03 §starter kits: the kit makes captures *classifiable*, not
 * *fileable*.
 *
 * This screen closes the gap by making the obvious gesture — "yes, those are all
 * right" — a single click. Every confirm goes through `assignThread`, so one
 * sweep fills the 20-slot few-shot window (06 §6) and the next import files
 * itself. The training is a side effect of a thing you wanted to do anyway,
 * which is the only kind of training a personal tool can ask for.
 */
export default function ReviewPage() {
  const { ready, screenshots, threads, threadName, assign, get } = useStore();
  const toast = useToast();
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);

  /**
   * Everything Capso has an opinion about but no confirmation for. Ordered
   * most-confident first: the run of easy yeses comes before the judgement
   * calls, so the sweep builds momentum instead of stalling on the hard one.
   */
  const pending = useMemo(
    () =>
      screenshots
        .filter(
          (s) =>
            !s.archived &&
            s.status === "done" &&
            s.threadId === null &&
            s.suggestedThreadId !== null,
        )
        .sort((a, b) => b.confidence - a.confidence),
    [screenshots],
  );

  /** No guess at all — these need a destination picked, not confirmed. */
  const unsorted = useMemo(
    () =>
      screenshots.filter(
        (s) => !s.archived && s.status === "done" && s.threadId === null && s.suggestedThreadId === null,
      ),
    [screenshots],
  );

  const current = pending[Math.min(cursor, pending.length - 1)];

  const file = useCallback(
    async (s: (typeof pending)[number], threadId: string | null) => {
      const previous = s.threadId;
      await assign(s, threadId, "inbox_triage");
      toast(`Seated in ${threadName(threadId)}`, () => {
        // Read fresh — see lib/move.ts for why replaying assign() with the
        // pre-file snapshot would clobber an edit made during the undo window.
        const current = get(s.id);
        if (current) void assign(current, previous, "manual");
      });
    },
    [assign, toast, threadName, get],
  );

  const confirmAll = useCallback(async () => {
    if (pending.length === 0) return;
    setBusy(true);
    const batch = [...pending];
    // Sequential: each assign writes a correction and updates thread recency,
    // and firing them together would race on the same thread rows.
    for (const s of batch) await assign(s, s.suggestedThreadId, "inbox_triage");
    setBusy(false);
    toast(`Seated ${batch.length} captures`, () => {
      // One undo for the whole sweep — restoring them one toast at a time would
      // be worse than not offering undo at all. Reads each capture fresh so an
      // edit made during the undo window is not overwritten by the pre-sweep
      // snapshot in `batch`.
      void (async () => {
        for (const s of batch) {
          const current = get(s.id);
          if (current) await assign(current, null, "manual");
        }
      })();
    });
  }, [pending, assign, toast, get]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName))
        return;
      if (!current) return;

      if (e.key === "j") setCursor((c) => Math.min(c + 1, pending.length - 1));
      if (e.key === "k") setCursor((c) => Math.max(c - 1, 0));
      if (e.key === "Enter") void file(current, current.suggestedThreadId);
      const n = Number(e.key);
      if (n >= 1 && n <= threads.length) void file(current, threads[n - 1]!.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, pending.length, threads, file]);

  if (!ready) return <SkeletonGrid />;

  if (pending.length === 0)
    return (
      <EmptyState
        title="Nothing left to review"
        body={
          unsorted.length > 0
            ? `Every suggestion has been confirmed. ${unsorted.length} capture${unsorted.length === 1 ? "" : "s"} still have no suggestion at all — they are in Unsorted on the library.`
            : "Every capture has been confirmed into a project. Capso learns from each one you kept or moved."
        }
        action={<Link href="/">Back to the library</Link>}
      />
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Review</h1>
          <p className="mt-1 text-xs text-muted">
            {pending.length} capture{pending.length === 1 ? "" : "s"} Capso has a guess for. Keeping
            one teaches it — the next import files itself.{" "}
            <span className="text-[11px]">j/k move · ⏎ keep · 1–{threads.length} pick project</span>
          </p>
        </div>

        <button
          onClick={() => void confirmAll()}
          disabled={busy}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink disabled:opacity-40"
        >
          {busy ? "Seating…" : `Confirm all ${pending.length}`}
        </button>
      </div>

      <ul className="space-y-3">
        {pending.map((s, i) => (
          <li
            key={s.id}
            onMouseEnter={() => setCursor(i)}
            className={`flex gap-4 rounded-xl bg-surface p-3 ring-1 ${
              i === cursor ? "ring-2 ring-accent" : "ring-line"
            }`}
          >
            <Link href={`/s/${s.id}`} className="w-24 shrink-0">
              <Thumb s={s} />
            </Link>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/s/${s.id}`} className="truncate text-sm font-medium hover:underline">
                  {s.title}
                </Link>
                <IntentChip intent={s.intent} />
                <ConfidenceBar value={s.confidence} />
              </div>

              <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted">{s.summary}</p>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => void file(s, s.suggestedThreadId)}
                  className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink"
                >
                  ✓ Confirm — {threadName(s.suggestedThreadId)}
                </button>

                <select
                  defaultValue=""
                  onChange={(e) => e.target.value && void file(s, e.target.value)}
                  className="rounded-md border border-line bg-surface px-2 py-1.5 text-xs"
                >
                  <option value="" disabled>
                    Move to…
                  </option>
                  {threads
                    .filter((t) => t.id !== s.suggestedThreadId)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                </select>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
