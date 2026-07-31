"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useStore } from "@/lib/store/provider";
import type { Screenshot } from "@/lib/store";
import { EmptyState, INTENT_LABEL, Thumb } from "@/components/ui";

type Tab = "learned" | "tidy" | "review";

/**
 * The memory surface. No pack doc specified this — corrections were written
 * invisibly and never shown back. If the product's claim is "it learns from
 * you", the learning has to be inspectable and correctable, or it's just a
 * hidden model doing things you can't argue with.
 */
export default function MemoryPage() {
  const [tab, setTab] = useState<Tab>("learned");
  const { ready } = useStore();

  if (!ready) return <p className="text-xs text-muted">Loading…</p>;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-sm font-semibold">Memory</h1>
        <p className="mt-1 text-xs text-muted">
          What Capso has worked out about how you save things — and where it&apos;s wrong.
        </p>
      </div>

      <nav className="flex gap-1 border-b border-line">
        {(
          [
            ["learned", "What it learned"],
            ["tidy", "Tidy up"],
            ["review", "Resurface"],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`-mb-px border-b-2 px-3 py-2 text-xs ${
              tab === key ? "border-accent font-medium" : "border-transparent text-muted"
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === "learned" && <Learned />}
      {tab === "tidy" && <Tidy />}
      {tab === "review" && <Review />}
    </div>
  );
}

/* ---------------------------------------------------------------- learned */

function Learned() {
  const { corrections, screenshots, threadName, forget } = useStore();

  const projectCorrections = corrections.filter((c) => c.field === "project");
  const accepted = projectCorrections.filter((c) => c.wasAiAccepted).length;
  const total = projectCorrections.length;
  const rate = total === 0 ? null : Math.round((accepted / total) * 100);

  // Rules are read straight out of the correction ledger: where you moved things
  // to, and what those captures had in common. This is exactly what gets injected
  // as few-shot context, shown back in plain language.
  const rules = useMemo(() => {
    const byTarget = new Map<string, { count: number; intents: Set<string> }>();
    for (const c of projectCorrections) {
      if (c.wasAiAccepted) continue;
      const shot = screenshots.find((s) => s.id === c.screenshotId);
      const entry = byTarget.get(c.userValue) ?? { count: 0, intents: new Set<string>() };
      entry.count += 1;
      if (shot) entry.intents.add(INTENT_LABEL[shot.intent]);
      byTarget.set(c.userValue, entry);
    }
    return [...byTarget.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [projectCorrections, screenshots]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-3">
        <Stat label="Suggestions accepted" value={rate === null ? "—" : `${rate}%`} />
        <Stat label="Corrections on file" value={String(total)} />
        <Stat
          label="Feeding the next guess"
          value={`${Math.min(corrections.length, 20)} of ${corrections.length}`}
        />
      </div>

      <section>
        <h2 className="mb-2 text-xs font-medium">Rules it has picked up</h2>
        {rules.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-xs text-muted">
            Nothing learned yet. Move a capture to a different project and the rule appears here.
          </p>
        ) : (
          <ul className="space-y-2">
            {rules.map(([target, { count, intents }]) => (
              <li
                key={target}
                className="rounded-lg bg-surface px-3 py-2.5 text-xs ring-1 ring-line"
              >
                <p>
                  When you correct it, you usually move things to{" "}
                  <span className="font-medium">{threadName(target === "inbox" ? null : target)}</span>{" "}
                  <span className="text-muted">
                    ({count} time{count === 1 ? "" : "s"}
                    {intents.size > 0 && ` · mostly ${[...intents].slice(0, 2).join(", ")}`})
                  </span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-xs font-medium">Correction history</h2>
        {corrections.length === 0 ? (
          <p className="text-xs text-muted">No corrections recorded yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {corrections.slice(0, 12).map((c) => {
              const shot = screenshots.find((s) => s.id === c.screenshotId);
              return (
                <li
                  key={c.id}
                  className="flex items-center gap-3 rounded-lg bg-surface px-3 py-2 text-xs ring-1 ring-line"
                >
                  <span className="min-w-0 flex-1">
                    {shot ? (
                      <Link href={`/s/${shot.id}`} className="font-medium hover:text-accent">
                        {shot.title}
                      </Link>
                    ) : (
                      <span className="text-muted">deleted capture</span>
                    )}
                    <span className="block text-muted">
                      {c.field === "project" ? "filed under" : `${c.field} set to`}{" "}
                      {c.field === "project"
                        ? threadName(c.userValue === "inbox" ? null : c.userValue)
                        : c.userValue}
                      {c.wasAiAccepted && " · agreed with Capso"}
                    </span>
                  </span>
                  <button
                    onClick={() => void forget(c.id)}
                    title="Stop using this as an example"
                    className="shrink-0 text-muted hover:text-accent"
                  >
                    Forget
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------- tidy */

function Tidy() {
  const { screenshots, threads, byThread, threadName, archive, remove } = useStore();
  const live = screenshots.filter((s) => !s.archived);

  // Same intent + overlapping title words reads as a near-duplicate. Cheap, and
  // it catches the real case: capturing the same screen twice in a week.
  const dupes = useMemo(() => {
    const pairs: [Screenshot, Screenshot][] = [];
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i]!;
        const b = live[j]!;
        if (a.intent !== b.intent) continue;
        const wa = new Set(a.title.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
        const wb = b.title.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
        const overlap = wb.filter((w) => wa.has(w)).length;
        if (overlap >= 2) pairs.push([a, b]);
      }
    }
    return pairs;
  }, [live]);

  const thin = threads.filter((t) => byThread(t.id).length > 0 && byThread(t.id).length < 3);
  const archived = screenshots.filter((s) => s.archived);

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-2 text-xs font-medium">Possible duplicates</h2>
        {dupes.length === 0 ? (
          <p className="text-xs text-muted">None found.</p>
        ) : (
          <ul className="space-y-2">
            {dupes.map(([a, b]) => (
              <li
                key={`${a.id}-${b.id}`}
                className="flex items-center gap-3 rounded-lg bg-surface p-2 ring-1 ring-line"
              >
                <div className="w-16 shrink-0">
                  <Thumb s={a} />
                </div>
                <div className="w-16 shrink-0">
                  <Thumb s={b} />
                </div>
                <p className="min-w-0 flex-1 text-xs">
                  <span className="block truncate">{a.title}</span>
                  <span className="block truncate text-muted">{b.title}</span>
                </p>
                <button
                  onClick={() => void archive(b, true)}
                  className="shrink-0 rounded-md border border-line px-2 py-1 text-xs"
                >
                  Archive second
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-xs font-medium">Thin projects</h2>
        <p className="mb-2 text-[11px] text-muted">
          Under three captures, Capso can&apos;t match reliably against a project — it falls back to
          guessing from the image alone.
        </p>
        {thin.length === 0 ? (
          <p className="text-xs text-muted">Every project has enough to work with.</p>
        ) : (
          <ul className="space-y-1.5">
            {thin.map((t) => (
              <li
                key={t.id}
                className="flex items-center gap-3 rounded-lg bg-surface px-3 py-2 text-xs ring-1 ring-line"
              >
                <span className="flex-1">
                  {t.name} <span className="text-muted">· {byThread(t.id).length} captures</span>
                </span>
                <Link href={`/threads/${t.id}`} className="text-muted hover:text-accent">
                  Open
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {archived.length > 0 && (
        <section>
          <h2 className="mb-2 text-xs font-medium">Archived ({archived.length})</h2>
          <ul className="space-y-1.5">
            {archived.map((s) => (
              <li
                key={s.id}
                className="flex items-center gap-3 rounded-lg bg-surface px-3 py-2 text-xs ring-1 ring-line"
              >
                <span className="min-w-0 flex-1 truncate">
                  {s.title} <span className="text-muted">· {threadName(s.threadId)}</span>
                </span>
                <button onClick={() => void archive(s, false)} className="text-muted hover:text-accent">
                  Restore
                </button>
                <button
                  onClick={async () => {
                    if (confirm("Delete permanently? Cannot be undone.")) await remove(s);
                  }}
                  className="text-muted hover:text-accent"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- review */

function Review() {
  const { screenshots, revisits, threadName, archive, visit } = useStore();
  const [done, setDone] = useState<Set<string>>(new Set());

  // Oldest captures you have never opened since saving — the ones the product
  // exists to stop you losing.
  const forgotten = useMemo(() => {
    const seen = new Set(revisits.map((r) => r.screenshotId));
    return screenshots
      .filter((s) => !s.archived && !seen.has(s.id) && !done.has(s.id))
      .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
      .slice(0, 5);
  }, [screenshots, revisits, done]);

  if (forgotten.length === 0)
    return (
      <EmptyState
        title="Nothing left to resurface"
        body="You've looked at everything you saved. Come back after a week of capturing."
        action="Capso surfaces captures you never opened again"
      />
    );

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        {forgotten.length} captures you saved and never opened again. Keep the useful ones, archive
        the rest.
      </p>

      {forgotten.map((s) => (
        <div key={s.id} className="flex gap-4 rounded-xl bg-surface p-3 ring-1 ring-line">
          <Link href={`/s/${s.id}`} className="w-24 shrink-0">
            <Thumb s={s} />
          </Link>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium">{s.title}</p>
            <p className="text-[11px] text-muted">
              {threadName(s.threadId)} · saved{" "}
              {new Date(s.capturedAt).toLocaleDateString("en-GB", { month: "long", year: "numeric" })}
            </p>
            <p className="mt-1 line-clamp-2 text-xs text-muted italic">{s.whySaved}</p>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => {
                  void visit(s.id, "opened_detail");
                  setDone((d) => new Set(d).add(s.id));
                }}
                className="rounded-md bg-accent px-3 py-1 text-xs text-white"
              >
                Still useful
              </button>
              <button
                onClick={() => void archive(s, true)}
                className="rounded-md border border-line px-3 py-1 text-xs"
              >
                Archive
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-surface px-4 py-3 ring-1 ring-line">
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      <p className="text-[11px] text-muted">{label}</p>
    </div>
  );
}
