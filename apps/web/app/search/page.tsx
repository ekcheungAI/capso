"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useStore } from "@/lib/store/provider";
import type { Screenshot } from "@/lib/store";
import { EmptyState, Masonry, Thumb } from "@/components/ui";
import { retrieve } from "@/lib/retrieve";

const EXAMPLES = [
  "what are some good designs I have put together for mobile UI",
  "the pricing page I saved in March",
  "bugs I found on the second display",
  "hooks I collected for the launch",
];

/**
 * Search is an agent over your memory, not a filter box. Typing filters
 * instantly (Google-style); asking sends the retrieved captures to the model and
 * answers in prose with citations — the Perplexity/ChatGPT overview split.
 */
export default function SearchPage() {
  const { ready, screenshots, threads, threadName, visit } = useStore();
  const [q, setQ] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const [answer, setAnswer] = useState<{ text: string; cited: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const hits = useMemo(() => retrieve(q, screenshots, threads), [q, screenshots, threads]);

  const ask = async (question: string) => {
    if (!question.trim() || busy) return;
    setBusy(true);
    setAnswer(null);
    setNote(null);
    setAsked(question);

    const scope = retrieve(question, screenshots, threads, 12);
    if (scope.length === 0) {
      setNote("Nothing in your memory matches that yet.");
      setBusy(false);
      return;
    }

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question,
          project: "your whole library",
          captures: scope.map(({ s }) => ({
            id: s.id,
            title: s.title,
            summary: s.summary,
            ocrExcerpt: `${s.whySaved}\n${s.ocrText}`,
            intent: s.intent,
          })),
        }),
      });

      if (res.status === 503) {
        setNote("Answering needs MINIMAX_TEXT_API_KEY. The results below are still real.");
      } else if (!res.ok) {
        setNote("The model call failed. Results below are still real.");
      } else {
        const data = (await res.json()) as { text: string; cited: string[] };
        setAnswer(data);
        for (const id of data.cited) await visit(id, "search_clicked");
      }
    } catch {
      setNote("Could not reach the answer endpoint.");
    } finally {
      setBusy(false);
    }
  };

  if (!ready) return <p className="text-xs text-muted">Loading…</p>;

  const shown = asked && answer ? retrieve(asked, screenshots, threads, 12) : hits;
  const citedSet = new Set(answer?.cited ?? []);

  return (
    <div className="space-y-5">
      <div className="flex gap-2">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void ask(q)}
          placeholder="Ask your memory anything…"
          className="flex-1 rounded-lg border border-line bg-surface px-4 py-2.5 text-sm"
        />
        <button
          onClick={() => void ask(q)}
          disabled={busy || !q.trim()}
          className="rounded-lg bg-accent px-4 py-2.5 text-xs font-medium text-accent-ink disabled:opacity-40"
        >
          {busy ? "Thinking…" : "Ask"}
        </button>
      </div>

      {!q && !asked && (
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((e) => (
            <button
              key={e}
              onClick={() => {
                setQ(e);
                void ask(e);
              }}
              className="rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-muted transition-colors duration-[120ms] hover:border-accent hover:text-foreground"
            >
              {e}
            </button>
          ))}
        </div>
      )}

      {busy && (
        <div className="capso-fade rounded-xl border border-line bg-surface p-4">
          <p className="text-[11px] text-muted">Reading your captures…</p>
          <div className="capso-skeleton mt-2 h-3 w-3/4 rounded" />
          <div className="capso-skeleton mt-1.5 h-3 w-1/2 rounded" />
        </div>
      )}

      {answer && (
        <div className="capso-fade rounded-xl border border-line bg-surface p-4">
          <p className="mb-2 text-[11px] uppercase tracking-wide text-muted">
            From your memory · {answer.cited.length} captures cited
          </p>
          <div className="text-sm leading-relaxed">
            <Cited text={answer.text} lookup={(id) => screenshots.find((s) => s.id === id)} />
          </div>
        </div>
      )}

      {note && (
        <p className="rounded-lg border border-line bg-surface px-3 py-2 text-xs text-muted">{note}</p>
      )}

      {q && (
        <p className="text-xs text-muted">
          {shown.length} match{shown.length === 1 ? "" : "es"}
          {shown.length > 0 && " · sorted by relevance"}
        </p>
      )}

      {q && shown.length === 0 && !busy && (
        <EmptyState
          title="Nothing matches"
          body="Capso searches titles, summaries, your own notes, the text inside each image, and the intent it assigned."
          action="Try a phrase you'd remember seeing"
        />
      )}

      {shown.length > 0 && (
        <Masonry
          items={shown.map(({ s }) => s)}
          noteFor={(s) => {
            const hit = shown.find((x) => x.s.id === s.id);
            const badge = citedSet.has(s.id) ? "★ cited · " : "";
            return `${badge}${threadName(s.threadId)} · matched on ${hit?.why ?? "content"}`;
          }}
        />
      )}
    </div>
  );
}

function Cited({ text, lookup }: { text: string; lookup: (id: string) => Screenshot | undefined }) {
  const parts = text.split(/(\[[a-z0-9]+\])/gi);
  return (
    <p>
      {parts.map((part, i) => {
        const m = /^\[([a-z0-9]+)\]$/i.exec(part);
        const shot = m ? lookup(m[1]!) : undefined;
        if (!shot) return <span key={i}>{part}</span>;
        return (
          <Link
            key={i}
            href={`/s/${shot.id}`}
            className="mx-1 inline-flex items-center gap-1 rounded border border-line px-1 py-0.5 align-middle text-[11px] text-muted transition-colors duration-[120ms] hover:border-accent hover:text-foreground"
          >
            <span className="inline-block h-3.5 w-3.5 overflow-hidden rounded-[2px]">
              <Thumb s={shot} className="h-3.5 w-3.5 rounded-none border-0 object-cover" />
            </span>
            {shot.title.split(" — ")[0]}
          </Link>
        );
      })}
    </p>
  );
}
