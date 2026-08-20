"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, MagnifyingGlass, Sparkle } from "@phosphor-icons/react";
import { useStore } from "@/lib/store/provider";
import type { Screenshot } from "@/lib/store";
import { ANSWERS_OFF, EmptyState, Masonry, SkeletonGrid, Thumb } from "@/components/ui";
import { retrieve } from "@/lib/retrieve";
import { plural } from "@/lib/plural";
import { citationId } from "@/lib/citations";
import { accountFetch } from "@/lib/supabase/client";
import { INTENTS, INTENT_LABEL } from "@/lib/intent";
import {
  EMPTY_SEARCH_FILTERS,
  matchesSearchFilters,
  parseSearchFilters,
  serializeSearchFilters,
  type SearchFilters,
} from "@/lib/search-filters";
import { defaultSearchCandidates, searchOrderLabel } from "@/lib/search-presentation";

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
  const { ready, screenshots, threads, threadName, visit, revisits } = useStore();
  const [filters, setFilters] = useState<SearchFilters>(EMPTY_SEARCH_FILTERS);
  const [urlReady, setUrlReady] = useState(false);
  const [debouncedQ, setDebouncedQ] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const [answer, setAnswer] = useState<{ text: string; cited: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // URL state makes a search reloadable and shareable. Popstate covers browser
  // Back/Forward because replaceState itself does not emit an event.
  useEffect(() => {
    const sync = () => {
      const next = parseSearchFilters(window.location.search);
      setFilters(next);
      setDebouncedQ(next.q);
      setUrlReady(true);
    };
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  // Keep typing responsive while retrieval and URL replacement wait briefly.
  useEffect(() => {
    if (!urlReady) return;
    const timer = window.setTimeout(() => {
      setDebouncedQ(filters.q);
      const query = serializeSearchFilters(filters);
      window.history.replaceState(null, "", query ? `/search?${query}` : "/search");
    }, 150);
    return () => window.clearTimeout(timer);
  }, [filters, urlReady]);

  const q = filters.q;
  const setQ = (value: string) => setFilters((current) => ({ ...current, q: value }));
  const hasFilters = Boolean(filters.project || filters.intent || filters.date !== "any");

  const hits = useMemo(
    () => {
      const candidates = debouncedQ
        ? retrieve(debouncedQ, screenshots, threads, screenshots.length, revisits)
        : defaultSearchCandidates(screenshots)
            .map((s) => ({ s, score: 0, why: "filters" }));
      return candidates.filter(({ s }) => matchesSearchFilters(s, filters)).slice(0, 12);
    },
    [debouncedQ, filters, screenshots, threads, revisits],
  );

  const ask = async (question: string) => {
    if (!question.trim() || busy) return;
    setBusy(true);
    setAnswer(null);
    setNote(null);
    setAsked(question);

    const scope = retrieve(question, screenshots, threads, screenshots.length, revisits)
      .filter(({ s }) => matchesSearchFilters(s, filters))
      .slice(0, 12);
    if (scope.length === 0) {
      setNote("Nothing in your memory matches that yet.");
      setBusy(false);
      return;
    }

    try {
      const res = await accountFetch("/api/chat", {
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
        setNote(ANSWERS_OFF);
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

  if (!ready) return <SkeletonGrid />;

  const shown = asked && answer
    ? retrieve(asked, screenshots, threads, screenshots.length, revisits)
        .filter(({ s }) => matchesSearchFilters(s, filters))
        .slice(0, 12)
    : hits;
  const citedSet = new Set(answer?.cited ?? []);

  return (
    <div className="mx-auto w-full max-w-[920px] px-5 py-10 sm:px-8 sm:py-14 lg:px-10">
      <header className="max-w-2xl">
        <p className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
          <Sparkle size={14} weight="fill" /> Organised around you
        </p>
        <h1 className="text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">Ask your organised memory</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Describe what you remember. Capso searches titles, OCR text, your notes, tags, projects and recent activity.
        </p>
      </header>

      <div className="mt-8 space-y-6">
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {busy
          ? "Reading your captures."
          : answer
            ? `Answer ready. ${plural(answer.cited.length, "capture")} cited.`
            : note ?? ""}
      </p>
      <label htmlFor="memory-search" className="sr-only">Search query</label>
      <div className="flex items-center gap-2 rounded-[22px] border border-line bg-surface p-2 shadow-sm transition focus-within:border-muted focus-within:ring-2 focus-within:ring-line">
        <MagnifyingGlass size={20} className="ml-3 shrink-0 text-muted" />
        <input
          id="memory-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void ask(q)}
          placeholder="Ask your memory anything…"
          className="capso-search-input h-12 min-w-0 flex-1 bg-transparent px-2 text-[15px] outline-none placeholder:text-muted"
        />
        <button
          onClick={() => void ask(q)}
          disabled={busy || !q.trim()}
          className="flex h-11 shrink-0 items-center gap-2 rounded-[15px] bg-accent px-4 text-xs font-semibold text-accent-ink transition disabled:opacity-35"
        >
          {busy ? "Thinking…" : "Ask"} {!busy && <ArrowRight size={15} />}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Search filters">
        <label>
          <span className="sr-only">Project</span>
          <select
            value={filters.project}
            onChange={(event) => setFilters((current) => ({ ...current, project: event.target.value }))}
            className="min-h-11 rounded-xl border border-line bg-surface px-3 text-xs font-medium"
          >
            <option value="">All projects</option>
            {threads.filter((thread) => !thread.archived).map((thread) => (
              <option key={thread.id} value={thread.id}>{thread.name}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Intent</span>
          <select
            value={filters.intent}
            onChange={(event) => setFilters((current) => ({ ...current, intent: event.target.value }))}
            className="min-h-11 rounded-xl border border-line bg-surface px-3 text-xs font-medium"
          >
            <option value="">All intents</option>
            {INTENTS.map((intent) => <option key={intent} value={intent}>{INTENT_LABEL[intent]}</option>)}
          </select>
        </label>
        <label>
          <span className="sr-only">Date captured</span>
          <select
            value={filters.date}
            onChange={(event) => setFilters((current) => ({ ...current, date: event.target.value as SearchFilters["date"] }))}
            className="min-h-11 rounded-xl border border-line bg-surface px-3 text-xs font-medium"
          >
            <option value="any">Any time</option>
            <option value="30d">Last 30 days</option>
            <option value="year">This year</option>
          </select>
        </label>
        {hasFilters && (
          <button
            type="button"
            onClick={() => setFilters((current) => ({ ...EMPTY_SEARCH_FILTERS, q: current.q }))}
            className="min-h-11 rounded-xl px-3 text-xs font-semibold text-muted underline underline-offset-4 hover:text-foreground"
          >
            Reset filters
          </button>
        )}
      </div>

      {hasFilters && (
        <div className="flex flex-wrap gap-2" aria-label="Active search filters">
          {filters.project && (
            <button type="button" onClick={() => setFilters((current) => ({ ...current, project: "" }))} className="min-h-11 rounded-full border border-line bg-surface px-3 text-xs">
              Project: {threadName(filters.project)} <span aria-hidden="true">×</span><span className="sr-only">, remove</span>
            </button>
          )}
          {filters.intent && (
            <button type="button" onClick={() => setFilters((current) => ({ ...current, intent: "" }))} className="min-h-11 rounded-full border border-line bg-surface px-3 text-xs">
              Intent: {INTENT_LABEL[filters.intent as keyof typeof INTENT_LABEL]} <span aria-hidden="true">×</span><span className="sr-only">, remove</span>
            </button>
          )}
          {filters.date !== "any" && (
            <button type="button" onClick={() => setFilters((current) => ({ ...current, date: "any" }))} className="min-h-11 rounded-full border border-line bg-surface px-3 text-xs">
              Date: {filters.date === "30d" ? "Last 30 days" : "This year"} <span aria-hidden="true">×</span><span className="sr-only">, remove</span>
            </button>
          )}
        </div>
      )}

      {!q && !asked && (
        <section aria-labelledby="search-starts-heading">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 id="search-starts-heading" className="text-sm font-semibold">Good places to start</h2>
            <span className="hidden text-xs text-muted sm:inline">Searches saved text, organisation and activity</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
          {EXAMPLES.map((e, index) => (
            <button
              key={e}
              onClick={() => {
                setQ(e);
                void ask(e);
              }}
              className="group flex min-h-14 items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3 text-left text-xs leading-relaxed text-muted transition-colors duration-[120ms] hover:border-accent hover:text-foreground"
            >
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-background text-xs font-semibold tabular-nums text-muted">0{index + 1}</span>
              <span className="min-w-0 flex-1">{e}</span>
              <ArrowRight size={15} className="shrink-0 opacity-45 transition group-hover:translate-x-0.5 group-hover:opacity-100" />
            </button>
          ))}
          </div>
        </section>
      )}

      {busy && (
        <div className="capso-fade rounded-xl border border-line bg-surface p-4">
          <p className="text-xs text-muted">Reading your captures…</p>
          <div className="capso-skeleton mt-2 h-3 w-3/4 rounded" />
          <div className="capso-skeleton mt-1.5 h-3 w-1/2 rounded" />
        </div>
      )}

      {answer && (
        <div className="capso-fade rounded-xl border border-line bg-surface p-4">
          <p className="mb-2 text-xs uppercase tracking-wide text-muted">
            From your memory · {plural(answer.cited.length, "capture")} cited
          </p>
          <div className="text-sm leading-relaxed">
            <Cited text={answer.text} lookup={(id) => screenshots.find((s) => s.id === id)} />
          </div>
        </div>
      )}

      {note && (
        <p className="rounded-lg border border-line bg-surface px-3 py-2 text-xs text-muted">{note}</p>
      )}

      {(q || hasFilters) && (
          <p className="text-xs text-muted">
            {shown.length} match{shown.length === 1 ? "" : "es"}
          {shown.length > 0 && ` · ${searchOrderLabel(Boolean((asked && answer) || debouncedQ))}`}
          </p>
      )}

      {(q || hasFilters) && shown.length === 0 && !busy && (
        <EmptyState
          title="Nothing matches"
          body="Capso searches titles, summaries, your own notes, the text inside each image, and the intent it assigned."
          action={
            <button type="button" onClick={() => setFilters(EMPTY_SEARCH_FILTERS)}>
              Clear this search
            </button>
          }
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
    </div>
  );
}

function Cited({ text, lookup }: { text: string; lookup: (id: string) => Screenshot | undefined }) {
  const parts = text.split(/(\[[A-Za-z0-9_-]+\])/g);
  return (
    <p>
      {parts.map((part, i) => {
        const id = citationId(part);
        const shot = id ? lookup(id) : undefined;
        if (!shot) return <span key={i}>{part}</span>;
        return (
          <Link
            key={i}
            href={`/s/${shot.id}`}
            aria-label={`Open source ${shot.title}`}
            className="mx-1 inline-flex min-h-11 items-center gap-1 rounded border border-line px-2 align-middle text-xs text-muted transition-colors duration-[120ms] hover:border-accent hover:text-foreground"
          >
            <span className="inline-block h-3.5 w-3.5 overflow-hidden rounded-[2px]">
              <Thumb s={shot} className="h-3.5 w-3.5 rounded-none border-0 object-cover" />
            </span>
            {shot.title.split(" - ")[0]}
          </Link>
        );
      })}
    </p>
  );
}
