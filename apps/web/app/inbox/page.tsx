"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useStore } from "@/lib/store/provider";
import { ConfidenceBar, EmptyState, IntentChip, Thumb } from "@/components/ui";

/**
 * Inbox triage — keyboard-first per 07: j/k navigate, ⏎ accepts the suggestion,
 * number keys pick a project. Three verbs only (Notion Mail): Confirm / Try again / Ignore.
 */
export default function InboxPage() {
  const { ready, inbox, threads, threadName, assign } = useStore();
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
        void assign(current, current.suggestedThreadId, "inbox_triage");
      }
      const n = Number(e.key);
      if (n >= 1 && n <= threads.length) {
        void assign(current, threads[n - 1]!.id, "inbox_triage");
      }
    },
    [current, inbox.length, threads, assign],
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
        <h1 className="text-sm font-semibold">Inbox</h1>
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
                <Link href={`/s/${s.id}`} className="truncate text-[13px] font-medium hover:text-accent">
                  {s.title}
                </Link>
                <IntentChip intent={s.intent} />
                <ConfidenceBar value={s.confidence} />
              </div>

              <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted">{s.summary}</p>
              <p className="mt-1 text-xs text-muted italic">{s.whySaved}</p>

              <p className="mt-2 text-xs">
                <span className="text-muted">Suggested — </span>
                <span className="font-medium">{threadName(s.suggestedThreadId)}</span>
              </p>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => void assign(s, s.suggestedThreadId, "inbox_triage")}
                  className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white"
                >
                  Confirm
                </button>

                <select
                  defaultValue=""
                  onChange={(e) => e.target.value && void assign(s, e.target.value, "inbox_triage")}
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
                  onClick={() => alert("Reclassify runs a fresh AI pass — wired up in Loop C.")}
                  className="rounded-md border border-line px-3 py-1.5 text-xs"
                >
                  Try again
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
