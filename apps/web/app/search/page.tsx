"use client";

import { useMemo, useState } from "react";
import { useStore } from "@/lib/store/provider";
import type { Screenshot } from "@/lib/store";
import { EmptyState, FilterPill, Masonry } from "@/components/ui";

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/** Naive keyword + month search. Loop C/E swap the ranking for embeddings. */
export default function SearchPage() {
  const { ready, screenshots, threadName, visit } = useStore();
  const [q, setQ] = useState("pricing page I saved in March");

  const { results, monthFilter, terms } = useMemo(() => {
    const lower = q.toLowerCase();
    const monthIdx = MONTHS.findIndex((m) => lower.includes(m));
    const words = lower
      .split(/\s+/)
      .filter((w) => w.length > 3 && !MONTHS.includes(w) && !["saved", "page", "that", "with"].includes(w));

    const hits = screenshots.filter((s) => {
      if (s.archived) return false;
      if (monthIdx >= 0 && new Date(s.capturedAt).getMonth() !== monthIdx) return false;
      if (words.length === 0) return true;
      const hay = `${s.title} ${s.summary} ${s.ocrText} ${s.whySaved} ${s.intent}`.toLowerCase();
      return words.some((w) => hay.includes(w));
    });

    return { results: hits, monthFilter: monthIdx, terms: words };
  }, [q, screenshots]);

  if (!ready) return <p className="text-xs text-muted">Loading…</p>;

  return (
    <div className="space-y-5">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Describe what you remember…"
        className="w-full rounded-lg border border-line bg-surface px-4 py-2.5 text-sm"
      />

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">Understood as</span>
        {monthFilter >= 0 && (
          <FilterPill label={`${MONTHS[monthFilter]![0]!.toUpperCase()}${MONTHS[monthFilter]!.slice(1)}`} removable />
        )}
        {terms.map((t) => (
          <FilterPill key={t} label={`text: ${t}`} removable />
        ))}
        {monthFilter < 0 && terms.length === 0 && <span className="text-xs text-muted">everything</span>}
        <button onClick={() => setQ("")} className="text-xs text-muted underline underline-offset-2">
          Reset
        </button>
        <span className="ml-auto text-xs text-muted">{results.length} results</span>
      </div>

      {results.length === 0 ? (
        <EmptyState
          title="Nothing matches"
          body="Try fewer words, or a phrase you'd actually remember seeing in the screenshot."
          action="Capso searches OCR text, summaries and your own notes"
        />
      ) : (
        <div onClickCapture={() => results.forEach((r) => void visit(r.id, "search_clicked"))}>
          <Masonry items={results} noteFor={(s) => matchReason(s, terms, threadName(s.threadId))} />
        </div>
      )}
    </div>
  );
}

function matchReason(s: Screenshot, terms: string[], thread: string) {
  const line = s.ocrText
    .split("\n")
    .find((l) => terms.some((t) => l.toLowerCase().includes(t)));
  return line ? `${thread} · matched OCR “${line.slice(0, 40)}”` : `${thread} · ${s.summary.slice(0, 50)}`;
}
