"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useStore } from "@/lib/store/provider";
import type { Intent, Screenshot } from "@/lib/store";
import { EmptyState, INTENT_LABEL, INTENTS, Masonry } from "@/components/ui";

type DateRange = "all" | "7d" | "30d" | "90d";

const RANGE_LABEL: Record<DateRange, string> = {
  all: "Any date",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
};

export default function LibraryPage() {
  const { ready, filed, inbox, threads, threadName, assign } = useStore();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [intent, setIntent] = useState<Intent | "all">("all");
  const [project, setProject] = useState<string>("all");
  // `since` is stamped when the user picks a range — Date.now() must not run during render.
  const [range, setRange] = useState<{ kind: DateRange; since: number }>({ kind: "all", since: 0 });

  const results = useMemo(
    () =>
      filed.filter(
        (s) =>
          (intent === "all" || s.intent === intent) &&
          (project === "all" || s.threadId === project) &&
          (range.kind === "all" || new Date(s.capturedAt).getTime() >= range.since),
      ),
    [filed, intent, project, range],
  );

  if (!ready) return <p className="text-xs text-muted">Loading…</p>;
  if (filed.length === 0)
    return (
      <EmptyState
        title="Nothing filed yet"
        body="Captures appear here once they belong to a project."
        action="Drop a screenshot anywhere, or press Capture"
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

  const filtering = intent !== "all" || project !== "all" || range.kind !== "all";

  return (
    <div className="space-y-6">
      {/* What needs you, before what you already dealt with. */}
      {inbox.length > 0 && (
        <Link
          href="/inbox"
          className="flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-2.5 text-xs hover:border-accent"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          <span>
            <span className="font-medium">{inbox.length} captures</span> need a project
          </span>
          <span className="ml-auto text-muted">Triage →</span>
        </Link>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Select value={intent} onChange={(v) => setIntent(v as Intent | "all")}>
          <option value="all">Any intent</option>
          {INTENTS.map((i) => (
            <option key={i} value={i}>
              {INTENT_LABEL[i]}
            </option>
          ))}
        </Select>

        <Select value={project} onChange={setProject}>
          <option value="all">Any project</option>
          {threads.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>

        <Select
          value={range.kind}
          onChange={(v) =>
            setRange({
              kind: v as DateRange,
              since: v === "all" ? 0 : Date.now() - Number(v.replace("d", "")) * 864e5,
            })
          }
        >
          {(Object.keys(RANGE_LABEL) as DateRange[]).map((r) => (
            <option key={r} value={r}>
              {RANGE_LABEL[r]}
            </option>
          ))}
        </Select>

        {filtering && (
          <button
            onClick={() => {
              setIntent("all");
              setProject("all");
              setRange({ kind: "all", since: 0 });
            }}
            className="text-xs text-muted underline underline-offset-2"
          >
            Reset
          </button>
        )}

        <span className="ml-auto text-xs text-muted">
          {results.length}
          {filtering && ` of ${filed.length}`} captures
        </span>
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

      {results.length === 0 ? (
        <EmptyState
          title="No captures match"
          body="These filters exclude everything you've saved so far."
          action="Reset the filters to see all captures"
        />
      ) : (
        groupByMonth(results).map(([month, items]) => (
          <section key={month}>
            <h2 className="mb-3 text-xs font-medium text-muted">
              {month}
              {project !== "all" && (
                <span className="ml-2 text-muted/70">· {threadName(project)}</span>
              )}
            </h2>
            <Masonry items={items} selected={selected} onSelect={toggle} />
          </section>
        ))
      )}
    </div>
  );
}

function Select({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-full border border-line bg-surface px-3 py-1.5 text-xs"
    >
      {children}
    </select>
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
