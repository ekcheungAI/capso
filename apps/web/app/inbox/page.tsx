"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useStore } from "@/lib/store/provider";
import { ConfidenceBar, EmptyState, IntentChip, SkeletonGrid, Thumb } from "@/components/ui";
import { useToast } from "@/components/toast";
import { useReclassify } from "@/lib/reclassify";
import { verb } from "@/lib/plural";

/**
 * Inbox triage — keyboard-first per 07: j/k navigate, ⏎ accepts the suggestion,
 * number keys pick a project. Three verbs only (Notion Mail): Confirm / Try again / Ignore.
 */
export default function InboxPage() {
  const { ready, inbox, threads, threadName, assign, get } = useStore();
  const { reread, busy } = useReclassify();
  const toast = useToast();

  // Filing is one click, so it needs a receipt and a way back.
  const file = useCallback(
    async (s: (typeof inbox)[number], threadId: string | null) => {
      const previous = s.threadId;
      await assign(s, threadId, "inbox_triage");
      toast(`Seated in ${threadName(threadId)}`, () => {
        // Read fresh — `s` is the pre-file snapshot, and replaying assign()
        // with it would overwrite any edit made during the undo window.
        const current = get(s.id);
        if (current) void assign(current, previous, "manual");
      });
    },
    [assign, toast, threadName, get],
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

  if (!ready) return <SkeletonGrid />;
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
          {inbox.length} {verb(inbox.length, "needs", "need")} a decision. Anything above 80% confidence was filed automatically.{" "}
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
              <Thumb s={s} box="4 / 3" />
            </Link>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/s/${s.id}`} className="truncate text-sm font-medium hover:underline">
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
                    Move to…
                  </option>
                  {threads.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>

                <button
                  disabled={busy === s.id}
                  onClick={() => void reread(s)}
                  className="rounded-md border border-line px-3 py-1.5 text-xs disabled:opacity-40"
                >
                  {busy === s.id ? "Reading…" : "Try again"}
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
