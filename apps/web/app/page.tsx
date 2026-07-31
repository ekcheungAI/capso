"use client";

import { useState } from "react";
import { useStore } from "@/lib/store/provider";
import type { Screenshot } from "@/lib/store";
import { EmptyState, FilterPill, Masonry } from "@/components/ui";

export default function LibraryPage() {
  const { ready, filed, threads, assign } = useStore();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  if (!ready) return <p className="text-xs text-muted">Loading…</p>;
  if (filed.length === 0)
    return (
      <EmptyState
        title="Nothing filed yet"
        body="Captures appear here once they belong to a project."
        action="Drop a screenshot anywhere on this page"
      />
    );

  const toggle = (id: string) =>
    setSelected((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const moveSelected = async (threadId: string) => {
    for (const id of selected) {
      const s = filed.find((x) => x.id === id);
      if (s) await assign(s, threadId, "manual");
    }
    setSelected(new Set());
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <FilterPill label="Any intent ▾" />
        <FilterPill label="Any project ▾" />
        <FilterPill label="Any date ▾" />
        <span className="ml-auto text-xs text-muted">{filed.length} captures</span>
      </div>

      {selected.size > 0 && (
        <div className="sticky top-16 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-xs">
          <span>{selected.size} selected</span>
          <span className="text-muted">move to</span>
          {threads.map((t) => (
            <button
              key={t.id}
              onClick={() => void moveSelected(t.id)}
              className="rounded-md border border-line px-2 py-1 hover:border-accent"
            >
              {t.name}
            </button>
          ))}
          <button onClick={() => setSelected(new Set())} className="ml-auto text-muted">
            Clear
          </button>
        </div>
      )}

      {groupByMonth(filed).map(([month, items]) => (
        <section key={month}>
          <h2 className="mb-3 text-xs font-medium text-muted">{month}</h2>
          <Masonry items={items} selected={selected} onSelect={toggle} />
        </section>
      ))}
    </div>
  );
}

/**
 * Month, not day. Fabric groups by day because its users save dozens daily; at a
 * personal ~3/day that yields one card per header and kills the grid density.
 */
function groupByMonth(items: Screenshot[]): [string, Screenshot[]][] {
  const map = new Map<string, Screenshot[]>();
  for (const s of [...items].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))) {
    const month = new Date(s.capturedAt).toLocaleDateString("en-GB", {
      month: "long",
      year: "numeric",
    });
    map.set(month, [...(map.get(month) ?? []), s]);
  }
  return [...map.entries()];
}
