"use client";

import { use } from "react";
import Link from "next/link";
import { useStore } from "@/lib/store/provider";
import { EmptyState, IntentChip, Thumb } from "@/components/ui";

export default function ThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { ready, byThread, threadName } = useStore();
  const shots = byThread(id);

  if (!ready) return <p className="text-xs text-muted">Loading…</p>;
  if (shots.length === 0)
    return (
      <EmptyState
        title={`Nothing in ${threadName(id)} yet`}
        body="Captures land here once you confirm the suggestion, or drag a card onto this project in the sidebar."
        action="Drop a screenshot anywhere to add one"
      />
    );

  const cited = shots.slice(0, 2);

  return (
    <div className="flex gap-6">
      <div className="min-w-0 flex-1 space-y-5">
        <div>
          <h1 className="text-sm font-semibold">{threadName(id)}</h1>
          <p className="mt-1 text-xs text-muted">{shots.length} captures in this project</p>
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1">
          {shots.map((s) => (
            <Link key={s.id} href={`/s/${s.id}`} className="w-24 shrink-0">
              <Thumb s={s} />
            </Link>
          ))}
        </div>

        <div className="space-y-4 border-t border-line pt-5">
          <div className="flex justify-end">
            <div className="max-w-xl rounded-xl bg-surface px-4 py-3 text-sm ring-1 ring-line">
              What&apos;s the common pattern across these?
            </div>
          </div>

          <div className="max-w-xl text-sm leading-relaxed">
            <p className="mb-2 text-[11px] text-muted">
              Searched your memory · {shots.length} captures read
            </p>
            <p>
              Two of them put the savings message on the billing toggle itself rather than beneath
              the price
              {cited.map((s) => (
                <Link
                  key={s.id}
                  href={`/s/${s.id}`}
                  className="mx-1 inline-flex items-center rounded border border-line px-1.5 py-0.5 align-middle text-[11px] text-muted hover:border-accent"
                >
                  {s.title.split(" — ")[0]}
                </Link>
              ))}
              . Both also lead with the middle tier.
            </p>
            <p className="mt-2 text-[11px] text-muted italic">
              Canned response — real streaming answers arrive in Loop E.
            </p>
          </div>
        </div>

        <div className="rounded-lg border border-line bg-surface px-4 py-3 text-sm text-muted">
          Ask about this project…
        </div>
      </div>

      <aside className="hidden w-64 shrink-0 lg:block">
        <p className="mb-2 text-[11px] uppercase tracking-wide text-muted">Sources · {cited.length}</p>
        <ul className="space-y-2">
          {cited.map((s) => (
            <li key={s.id} className="rounded-lg bg-surface p-2 ring-1 ring-line">
              <Link href={`/s/${s.id}`}>
                <Thumb s={s} />
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
