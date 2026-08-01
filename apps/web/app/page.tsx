"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useStore } from "@/lib/store/provider";
import { useMoveCaptures } from "@/lib/move";
import type { Intent, Screenshot, Thread } from "@/lib/store";
import {
  DropZone,
  EmptyState,
  INTENT_LABEL,
  INTENTS,
  LedgerStrip,
  Masonry,
  SkeletonGrid,
  useDragCount,
} from "@/components/ui";

type DateRange = "all" | "7d" | "30d" | "90d";
type Grouping = "project" | "month" | "intent";

const RANGE_LABEL: Record<DateRange, string> = {
  all: "Any date",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
};

const GROUPINGS: [Grouping, string][] = [
  ["project", "Projects"],
  ["month", "Months"],
  ["intent", "Intent"],
];

/**
 * The library defaults to project shelves rather than a chronological wall.
 * Capture is deliberately messy; this page is where the mess is shown to have
 * been sorted, so the shape of the collection has to be the first thing read —
 * not a date you did not choose and cannot remember.
 */
export default function LibraryPage() {
  const { ready, screenshots, filed, inbox, threads, threadName, assign } = useStore();
  const move = useMoveCaptures();
  const dragCount = useDragCount();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [grouping, setGrouping] = useState<Grouping>("project");
  const [intent, setIntent] = useState<Intent | "all">("all");
  const [project, setProject] = useState<string>("all");
  // `since` is stamped when the user picks a range — Date.now() must not run during render.
  const [range, setRange] = useState<{ kind: DateRange; since: number }>({ kind: "all", since: 0 });

  /**
   * Which shelf a capture belongs on. A confirmed capture sits in its project;
   * an unconfirmed one sits in the project Capso *thinks* it belongs to, marked
   * as unconfirmed. `null` means no guess at all — the Unsorted shelf.
   *
   * This is the fix for the library's central lie: `results` used to be derived
   * from `filed`, so an unconfirmed capture rendered in no shelf, no month and
   * no intent group. Nine imported screenshots produced five shelves all saying
   * "Nothing here yet" above a badge reading "3 waiting".
   */
  const shelfOf = (s: Screenshot) => s.threadId ?? s.suggestedThreadId ?? null;

  const results = useMemo(
    () =>
      screenshots.filter(
        (s) =>
          !s.archived &&
          (intent === "all" || s.intent === intent) &&
          (project === "all" || shelfOf(s) === project) &&
          (range.kind === "all" || new Date(s.capturedAt).getTime() >= range.since),
      ),
    [screenshots, intent, project, range],
  );

  /** Captures with no home and no guess — otherwise invisible everywhere. */
  const unsorted = useMemo(() => results.filter((s) => shelfOf(s) === null), [results]);

  // Shelves are ordered by recency of use, so the project you are working in
  // rises to the top — including right after you drop something into it. Untouched
  // projects share a timestamp and fall back to creation order, which keeps a
  // fresh starter kit in the order it was offered.
  const shelves = useMemo(() => {
    const visible = project === "all" ? threads : threads.filter((t) => t.id === project);
    return [...visible]
      .filter((t) => !t.archived)
      .sort(
        (a, b) =>
          b.lastActiveAt.localeCompare(a.lastActiveAt) || a.createdAt.localeCompare(b.createdAt),
      );
  }, [threads, project]);

  const filtering = intent !== "all" || project !== "all" || range.kind !== "all";

  if (!ready) return <SkeletonGrid />;
  if (screenshots.length === 0 && threads.length === 0)
    return (
      <EmptyState
        title="Your visual memory starts with one screenshot"
        body="Drop an image anywhere on this page, paste from the clipboard, or press Capture."
        action="Nothing you save here needs filing — that part is handled"
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
    await move(threadId, [...selected]);
    setSelected(new Set());
  };

  /**
   * Confirming from the card writes the same correction as confirming from the
   * Inbox — `assignThread` is the only path that files anything, so the learning
   * loop stays whole no matter which surface the user happened to be looking at.
   */
  const suggestionFor = (s: Screenshot) =>
    s.threadId === null && s.suggestedThreadId !== null && s.status !== "processing"
      ? {
          label: threadName(s.suggestedThreadId),
          onConfirm: () => void assign(s, s.suggestedThreadId, "inbox_triage"),
        }
      : undefined;

  return (
    <div className="space-y-6">
      {/* The page had no heading element at all, so assistive tech got no outline
          for the most-visited screen. Kept visually hidden rather than imposing a
          title on a canvas where search and the sidebar already establish scope. */}
      <h1 className="sr-only">Everything you have captured</h1>

      {/* What needs you, before what you already dealt with. */}
      {inbox.length > 0 && (
        <Link
          // Three or more is a batch, and a batch is faster to clear in one
          // sweep than card by card — that is the whole reason /review exists.
          href={inbox.length >= 3 ? "/review" : "/inbox"}
          className="flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-2.5 text-xs hover:border-accent"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          <span>
            <span className="font-medium">{inbox.length} captures</span> need a project
          </span>
          <span className="ml-auto text-muted">
            {inbox.length >= 3 ? "Review all →" : "Triage →"}
          </span>
        </Link>
      )}

      <LedgerStrip
        captured={screenshots.length}
        filed={filed.length}
        projects={threads.filter((t) => !t.archived).length}
        waiting={inbox.length}
        archived={screenshots.filter((s) => s.archived).length}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Segmented value={grouping} options={GROUPINGS} onChange={setGrouping} />

        <span className="mx-1 h-4 w-px bg-line" />

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

      {grouping === "project" ? (
        shelves.length === 0 ? (
          <EmptyState
            title="No projects yet"
            body="Make one in the sidebar, or let a capture suggest its own from the Inbox."
            action="Group by month to browse everything chronologically"
          />
        ) : (
          <>
            {shelves.map((t) => {
              const items = results.filter((s) => shelfOf(s) === t.id);
              return (
                <Shelf
                  key={t.id}
                  thread={t}
                  items={items}
                  waiting={items.filter((s) => s.threadId === null).length}
                  armed={dragCount > 0}
                  onDropIds={(ids) => void move(t.id, ids)}
                  selected={selected}
                  onSelect={toggle}
                  suggestionFor={suggestionFor}
                />
              );
            })}

            {/* Pinned last: the pile with no guess attached. Without it a
                capture whose classification produced no project is in the
                database and on no screen. */}
            {unsorted.length > 0 && (
              <section className="-mx-2 px-2 py-2">
                <div className="mb-3 flex flex-wrap items-baseline gap-2">
                  <h2 className="text-base font-semibold tracking-tight">Unsorted</h2>
                  <span className="text-xs text-muted tabular-nums">{unsorted.length}</span>
                  <span className="hidden min-w-0 flex-1 truncate text-[11px] text-muted sm:block">
                    Capso had no guess for these. Drag one onto a project, or open it to file it.
                  </span>
                </div>
                <Masonry items={unsorted} selected={selected} onSelect={toggle} />
              </section>
            )}
          </>
        )
      ) : results.length === 0 ? (
        <EmptyState
          title={filtering ? "No captures match" : "Nothing captured yet"}
          body={
            filtering
              ? "These filters exclude everything you've saved so far."
              : "Drop an image anywhere on this page, paste from the clipboard, or press Capture."
          }
          action={filtering ? "Reset the filters to see all captures" : "Your first capture files itself"}
        />
      ) : (
        (grouping === "month" ? groupByMonth(results) : groupByIntent(results)).map(
          ([label, items]) => (
            <section key={label}>
              <h2 className="mb-3 text-sm font-medium text-muted">
                {label} <span className="text-muted/60">· {items.length}</span>
              </h2>
              <Masonry items={items} selected={selected} onSelect={toggle} />
            </section>
          ),
        )
      )}
    </div>
  );
}

/**
 * One project, its captures, and — the part that makes the page a receipt
 * rather than a grid — how many Inbox captures are still headed for it.
 */
function Shelf({
  thread,
  items,
  waiting,
  armed,
  onDropIds,
  selected,
  onSelect,
  suggestionFor,
}: {
  thread: Thread;
  items: Screenshot[];
  waiting: number;
  armed: boolean;
  onDropIds: (ids: string[]) => void;
  selected: Set<string>;
  onSelect: (id: string) => void;
  suggestionFor?: (s: Screenshot) => { label: string; onConfirm: () => void } | undefined;
}) {
  return (
    <DropZone armed={armed} onDropIds={onDropIds} lift={false} className="-mx-2 px-2 py-2">
      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <h2 className="text-base font-semibold tracking-tight">
          <Link href={`/threads/${thread.id}`} className="hover:text-accent">
            {thread.name}
          </Link>
        </h2>
        <span className="text-xs text-muted tabular-nums">{items.length}</span>

        {waiting > 0 && (
          <span
            title={`${waiting} capture${waiting === 1 ? "" : "s"} on this shelf are suggestions Capso has not had confirmed`}
            className="rounded-full border border-accent/40 px-2 py-0.5 text-[11px] text-accent"
          >
            {waiting} to confirm
          </span>
        )}

        {thread.description && (
          <span className="hidden min-w-0 flex-1 truncate text-[11px] text-muted sm:block">
            {thread.description}
          </span>
        )}

        <span className="ml-auto shrink-0 text-[11px] text-muted">
          {new Date(thread.lastActiveAt).toLocaleDateString("en-GB", {
            day: "numeric",
            month: "short",
          })}
        </span>
      </div>

      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-3 py-3 text-center text-[11px] text-muted">
          Nothing here yet — drag a capture onto this row.
        </p>
      ) : (
        <Masonry
          items={items}
          selected={selected}
          onSelect={onSelect}
          suggestionFor={suggestionFor}
        />
      )}
    </DropZone>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex rounded-full border border-line bg-surface p-0.5">
      {options.map(([key, label]) => (
        <button
          key={key}
          onClick={() => withTransition(() => onChange(key))}
          className={`rounded-full px-3 py-1 text-xs ${
            value === key ? "bg-accent font-medium text-accent-ink" : "text-muted"
          }`}
        >
          {label}
        </button>
      ))}
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
      onChange={(e) => withTransition(() => onChange(e.target.value))}
      className="rounded-full border border-line bg-surface px-3 py-1.5 text-xs"
    >
      {children}
    </select>
  );
}

/**
 * Regrouping re-flows the whole page; a view transition makes surviving cards
 * travel to their new slot rather than everything repainting at once.
 */
function withTransition(run: () => void) {
  if (typeof document.startViewTransition === "function") document.startViewTransition(run);
  else run();
}

const byNewest = (a: Screenshot, b: Screenshot) => b.capturedAt.localeCompare(a.capturedAt);

/**
 * Month, not day. Fabric groups by day because its users save dozens daily; at a
 * personal ~3/day that yields one card per header and kills the grid density.
 */
function groupByMonth(items: Screenshot[]): [string, Screenshot[]][] {
  const map = new Map<string, Screenshot[]>();
  for (const s of [...items].sort(byNewest)) {
    const month = new Date(s.capturedAt).toLocaleDateString("en-GB", {
      month: "long",
      year: "numeric",
    });
    map.set(month, [...(map.get(month) ?? []), s]);
  }
  return [...map.entries()];
}

/** Cuts across projects: every competitor screenshot you own, wherever it lives. */
function groupByIntent(items: Screenshot[]): [string, Screenshot[]][] {
  const map = new Map<string, Screenshot[]>();
  for (const s of [...items].sort(byNewest)) {
    const label = INTENT_LABEL[s.intent];
    map.set(label, [...(map.get(label) ?? []), s]);
  }
  return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
}
