"use client";

import { use, useMemo, useState } from "react";
import Link from "next/link";
import { useStore } from "@/lib/store/provider";
import type { Screenshot } from "@/lib/store";
import { ANSWERS_OFF, EmptyState, IntentChip, SkeletonGrid, Thumb } from "@/components/ui";
import { CapsoMark } from "@/components/mark.generated";
import { retrieve } from "@/lib/retrieve";
import { plural } from "@/lib/plural";

export default function ThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { ready, byThread, screenshots, threadName, threadMessages, say, threads, visit, revisits } =
    useStore();

  const shots = byThread(id);
  const messages = threadMessages(id);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // Citations from the last answer drive the sources rail.
  const lastCited = useMemo(() => {
    const last = [...messages].reverse().find((m) => m.role === "assistant");
    return (last?.citedIds ?? [])
      .map((cid) => screenshots.find((s) => s.id === cid))
      .filter((s): s is Screenshot => Boolean(s));
  }, [messages, screenshots]);

  const rail = lastCited.length > 0 ? lastCited : shots.slice(0, 2);

  if (!ready) return <SkeletonGrid />;
  if (shots.length === 0)
    return (
      <EmptyState
        title={`Nothing in ${threadName(id)} yet`}
        body="Captures land here once you confirm the suggestion, or drag a card onto this project in the sidebar."
        action="Drop a screenshot anywhere to add one"
      />
    );

  const ask = async () => {
    const question = q.trim();
    if (!question || busy) return;
    setQ("");
    setBusy(true);
    setNote(null);
    await say({ threadId: id, role: "user", text: question, citedIds: [] });

    // Retrieval: this project's captures ranked by relevance to the question —
    // not every capture in chronological (effectively oldest-first) order —
    // then anything else matching, capped at 12 total like /search instead of
    // sending the whole project unranked and unbounded on every question.
    const CHAT_SCOPE_LIMIT = 12;
    const ranked = retrieve(question, shots, threads, shots.length, revisits).map((r) => r.s);
    // A generic question ("what do these have in common?") scores below
    // retrieve()'s threshold on every capture — fall back to recency rather
    // than sending nothing.
    const inProject = (
      ranked.length > 0 ? ranked : [...shots].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
    ).slice(0, CHAT_SCOPE_LIMIT);
    const remaining = CHAT_SCOPE_LIMIT - inProject.length;
    const others =
      remaining > 0
        ? retrieve(question, screenshots.filter((s) => s.threadId !== id), threads, remaining, revisits).map(
            (r) => r.s,
          )
        : [];
    const scope = [...inProject, ...others];

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question,
          project: threadName(id),
          history: messages.slice(-6).map((m) => ({ role: m.role, text: m.text })),
          captures: scope.map((s) => ({
            id: s.id,
            title: s.title,
            summary: s.summary,
            ocrExcerpt: s.ocrText,
            intent: s.intent,
          })),
        }),
      });

      if (res.status === 503) {
        setNote(
          ANSWERS_OFF,
        );
      } else if (!res.ok) {
        const { error } = (await res.json()) as { error?: string };
        setNote(error ?? "The model call failed.");
      } else {
        const { text, cited } = (await res.json()) as { text: string; cited: string[] };
        await say({ threadId: id, role: "assistant", text, citedIds: cited });
        for (const cid of cited) await visit(cid, "referenced_in_chat");
      }
    } catch {
      setNote("Could not reach the chat endpoint.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      <div className="min-w-0 flex-1 space-y-5">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{threadName(id)}</h1>
          <p className="mt-1 text-xs text-muted">{plural(shots.length, "capture")} in this project</p>
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1">
          {shots.map((s) => (
            <Link key={s.id} href={`/s/${s.id}`} className="w-24 shrink-0">
              <Thumb s={s} box="4 / 3" />
            </Link>
          ))}
        </div>

        <div className="space-y-4 border-t border-line pt-5">
          {messages.length === 0 && (
            <p className="text-xs text-muted">
              Ask about these captures — &ldquo;what do these have in common?&rdquo;,
              &ldquo;which one had the annual toggle?&rdquo;
            </p>
          )}

          {messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="flex justify-end">
                <div className="max-w-xl rounded-xl bg-surface px-4 py-3 text-sm ring-1 ring-line">
                  {m.text}
                </div>
              </div>
            ) : (
              <div key={m.id} className="max-w-xl text-sm leading-relaxed">
                <p className="mb-2 text-[11px] text-muted">
                  Searched your memory ·{" "}
                  {m.citedIds.length === 0 ? "no captures" : plural(m.citedIds.length, "capture")} cited
                </p>
                <Answer text={m.text} lookup={(cid) => screenshots.find((s) => s.id === cid)} />
              </div>
            ),
          )}

          {busy && (
            <p className="flex items-center gap-2 text-xs text-muted">
              <CapsoMark size={14} className="capso-reading" />
              Reading your captures…
            </p>
          )}
          {note && (
            <p className="rounded-lg border border-line bg-surface px-3 py-2 text-xs text-muted">
              {note}
            </p>
          )}
        </div>

        <div className="flex gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void ask()}
            placeholder="Ask about this project…"
            className="flex-1 rounded-lg border border-line bg-surface px-4 py-2.5 text-sm"
          />
          <button
            onClick={() => void ask()}
            disabled={busy || !q.trim()}
            className="rounded-lg bg-accent px-4 py-2.5 text-xs font-medium text-accent-ink disabled:opacity-40"
          >
            Ask
          </button>
        </div>
      </div>

      {/* Content, not navigation — this used to be `hidden ... lg:block`,
          which hid the citation thumbnails entirely below 1024px with no
          fallback. Below lg it's a horizontal strip, matching the captures
          row above; at lg+ it's the original right-hand column. */}
      <aside className="w-full shrink-0 lg:w-64">
        <p className="mb-2 text-[11px] uppercase tracking-wide text-muted">
          {lastCited.length > 0 ? `Sources · ${rail.length}` : `In this project · ${rail.length}`}
        </p>
        <ul className="flex gap-2 overflow-x-auto pb-1 lg:block lg:space-y-2 lg:overflow-visible lg:pb-0">
          {rail.map((s) => (
            <li key={s.id} className="w-32 shrink-0 rounded-lg bg-surface p-2 ring-1 ring-line lg:w-auto">
              <Link href={`/s/${s.id}`}>
                <Thumb s={s} box="4 / 3" />
              </Link>
              <p className="mt-1.5 truncate text-[11px] font-medium">{s.title}</p>
              <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted">
                {s.ocrText.split("\n")[0]}
              </p>
              <div className="mt-1.5">
                <IntentChip intent={s.intent} />
              </div>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}

/** Renders [id] citations as chips linking to the capture they name. */
function Answer({
  text,
  lookup,
}: {
  text: string;
  lookup: (id: string) => Screenshot | undefined;
}) {
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
            className="mx-1 inline-flex items-center rounded border border-line px-1.5 py-0.5 align-middle text-[11px] text-muted hover:border-accent"
          >
            {shot.title.split(" — ")[0]}
          </Link>
        );
      })}
    </p>
  );
}
