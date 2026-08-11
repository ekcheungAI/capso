"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useStore } from "@/lib/store/provider";
import { useMoveCaptures } from "@/lib/move";
import { resurface } from "@/lib/resurface";
import { allTags, tagCounts } from "@/lib/tags";
import type { Intent, Screenshot, Thread } from "@/lib/store";
import {
  DropZone,
  EmptyState,
  INTENT_LABEL,
  INTENTS,
  LedgerStrip,
  Masonry,
  SkeletonGrid,
  Thumb,
  useDragCount,
} from "@/components/ui";
import { plural, verb } from "@/lib/plural";

type DateRange = "all" | "7d" | "30d" | "90d";
type Grouping = "gallery" | "project" | "month" | "intent";

const RANGE_LABEL: Record<DateRange, string> = {
  all: "Any date",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
};

const GROUPINGS: [Grouping, string][] = [
  ["gallery", "Gallery"],
  ["project", "Projects"],
  ["month", "Months"],
  ["intent", "Intent"],
];

/**
 * The library opens as one gallery of everything, newest first.
 *
 * This reverses the loop-12a default of project shelves, and the reasoning is
 * worth recording rather than quietly flipping. Shelves are the right way to
 * show that filing *happened* — but they answer a question you only have once
 * the library is full, and they pay for it by splitting the collection into
 * rows that are mostly empty and mostly below the fold. A screenshot tool whose
 * front page is five headings reading "Nothing here yet" is showing you its
 * filing cabinet instead of your screenshots, which inverts principle 5: the
 * captures are the hero and the chrome recedes.
 *
 * Shelves are one click away and everything that made them good is intact -
 * this changes which question the page answers first, not what it can answer.
 */
export default function LibraryPage() {
  const { ready, screenshots, filed, inbox, threads, threadName, assign, revisits } = useStore();
  const move = useMoveCaptures();
  const dragCount = useDragCount();
  // Stamped once per mount rather than read during render, for the same reason
  // `range.since` is: Date.now() in a render body is not a pure function.
  const [mountedAt] = useState(() => Date.now());

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [grouping, setGrouping] = useState<Grouping>("gallery");
  const [intent, setIntent] = useState<Intent | "all">("all");
  const [project, setProject] = useState<string>("all");
  /**
   * A fourth filter, against the tripwire in 15 §reference board — which says
   * add one only when a real query fails without it. This is that case: a
   * capture belongs to exactly one project but is about several things, and
   * "the pricing screens, whichever project they landed in" had no way to be
   * asked. Tags were computed on every capture and navigable from nowhere.
   */
  const [tag, setTag] = useState<string>("all");
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
          (tag === "all" || allTags(s).includes(tag)) &&
          (range.kind === "all" || new Date(s.capturedAt).getTime() >= range.since),
      ),
    [screenshots, intent, project, tag, range],
  );

  /** Every tag in the library, most-used first — the filter's options. */
  const tags = useMemo(() => tagCounts(screenshots), [screenshots]);

  /** Captures with no home and no guess — otherwise invisible everywhere. */
  const unsorted = useMemo(() => results.filter((s) => shelfOf(s) === null), [results]);

  /** The gallery: everything that survived the filters, newest first. */
  const gallery = useMemo(
    () => [...results].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)),
    [results],
  );

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

  const filtering =
    intent !== "all" || project !== "all" || tag !== "all" || range.kind !== "all";

  /**
   * The second clause of the brand promise: the rack holds everything, Capso
   * knows which one to pull. Deliberately not filtered with the library below -
   * this is Capso's choice, not a view of the user's, so a filter the user set
   * on the grid must not silently change what gets resurfaced.
   */
  const worthALook = useMemo(
    () => resurface(screenshots, revisits, threadName, 3, mountedAt),
    [screenshots, revisits, threadName, mountedAt],
  );

  /** How many Inbox captures /review can actually act on — it only sweeps guesses. */
  const sweepable = useMemo(
    () => inbox.filter((s) => s.status === "done" && s.suggestedThreadId !== null).length,
    [inbox],
  );

  if (!ready) return <SkeletonGrid />;
  if (screenshots.length === 0 && threads.length === 0)
    return (
      <EmptyState
        title="Your visual memory starts with one screenshot"
        body="Drop an image anywhere on this page, paste from the clipboard, or press Capture."
        action="Nothing you save here needs filing - that part is handled"
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

  const resetFilters = () => {
    setIntent("all");
    setProject("all");
    setTag("all");
    setRange({ kind: "all", since: 0 });
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
      <header>
        <h1 className="text-3xl font-semibold tracking-[-0.04em]">Library</h1>
        <p className="mt-1.5 text-xs text-muted">
          Every screenshot has one calm home. Tags connect ideas across projects.
        </p>
      </header>

      {/* What needs you, before what you already dealt with. */}
      {inbox.length > 0 && (
        <Link
          // Send to the sweep whenever there is anything to sweep. The old
          // threshold was three, which meant two pending suggestions could not
          // reach /review at all — and a two-item sweep is still a sweep.
          href={sweepable > 0 ? "/review" : "/inbox"}
          className="flex min-h-11 items-center gap-3 rounded-lg border border-line bg-surface px-4 text-xs hover:border-accent"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          <span>
            <span className="font-medium">{plural(inbox.length, "capture")}</span>{" "}
            {verb(inbox.length, "needs", "need")} a project
          </span>
          <span className="ml-auto text-muted">{sweepable > 0 ? "Review all →" : "Triage →"}</span>
        </Link>
      )}

      <LedgerStrip
        captured={screenshots.length}
        filed={filed.length}
        projects={threads.filter((t) => !t.archived).length}
        waiting={inbox.length}
        archived={screenshots.filter((s) => s.archived).length}
      />

      {/* Hidden while filtering: the grid below is then answering a question the
          user asked, and an unrelated suggestion on top of it is interruption. */}
      {!filtering && <ResurfaceShelf items={worthALook} />}

      <div className="flex flex-wrap items-center gap-2">
        <Segmented label="Group library" value={grouping} options={GROUPINGS} onChange={setGrouping} />

        {/* Divides the grouping tabs from the filters. Hidden once the row wraps:
            on a phone the two groups already sit on separate lines, so the rule
            stops dividing anything and just dangles at the end of the tabs. */}
        <span className="mx-1 hidden h-4 w-px bg-line sm:block" />

        <Select label="Filter by intent" value={intent} onChange={(v) => setIntent(v as Intent | "all")}>
          <option value="all">Any intent</option>
          {INTENTS.map((i) => (
            <option key={i} value={i}>
              {INTENT_LABEL[i]}
            </option>
          ))}
        </Select>

        <Select label="Filter by project" value={project} onChange={setProject}>
          <option value="all">Any project</option>
          {threads.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>

        {tags.length > 0 && (
          <Select label="Filter by tag" value={tag} onChange={setTag}>
            <option value="all">Any tag</option>
            {tags.map(([t, n]) => (
              <option key={t} value={t}>
                {t} ({n})
              </option>
            ))}
          </Select>
        )}

        <Select
          label="Filter by date"
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
          <button onClick={resetFilters} className="min-h-11 px-2 text-xs text-muted underline underline-offset-2">
            Reset
          </button>
        )}

        <span className="ml-auto text-xs text-muted">
          {results.length}
          {filtering ? ` of ${filed.length}` : ""} {verb(results.length, "capture", "captures")}
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
              className="min-h-11 rounded-md border border-line px-3 hover:border-accent"
            >
              {t.name}
            </button>
          ))}
          <button onClick={() => setSelected(new Set())} className="ml-auto min-h-11 px-2 text-muted">
            Clear
          </button>
        </div>
      )}

      {grouping === "gallery" ? (
        gallery.length === 0 ? (
          // A library with projects but no captures used to land on five shelf
          // headings all reading "Nothing here yet" — five statements of
          // absence where one belongs.
          <EmptyState
            title={filtering ? "No captures match" : "Nothing captured yet"}
            body={
              filtering
                ? "These filters exclude everything you've saved so far."
                : "Drop an image anywhere on this page, paste from the clipboard, or press Capture."
            }
            action={
              filtering ? (
                <button onClick={resetFilters}>Reset the filters to see all captures</button>
              ) : (
                <Link href="/extension">Capture from a browser tab</Link>
              )
            }
          />
        ) : (
          // Everything, newest first, undivided. The filters above still narrow
          // it and the shelf views are one click away — this is the wall of
          // screenshots the product is for, not a view of its filing.
          <Masonry
            items={gallery}
            selected={selected}
            onSelect={toggle}
            suggestionFor={suggestionFor}
            onTagClick={(t) => withTransition(() => setTag(t === tag ? "all" : t))}
            activeTag={tag === "all" ? undefined : tag}
          />
        )
      ) : grouping === "project" ? (
        shelves.length === 0 ? (
          <EmptyState
            title="No projects yet"
            body="Make one in the sidebar, or let a capture suggest its own from the Inbox."
            action={
              <button onClick={() => withTransition(() => setGrouping("gallery"))}>
                Show every capture instead
              </button>
            }
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
                  <span className="hidden min-w-0 flex-1 truncate text-xs text-muted sm:block">
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
          action={
            filtering ? (
              <button onClick={resetFilters}>Reset the filters to see all captures</button>
            ) : (
              "Your first capture files itself"
            )
          }
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
          <Link href={`/threads/${thread.id}`} className="hover:underline">
            {thread.name}
          </Link>
        </h2>
        <span className="text-xs text-muted tabular-nums">{items.length}</span>

        {waiting > 0 && (
          <span
            title={`${waiting} capture${waiting === 1 ? "" : "s"} on this shelf are suggestions Capso has not had confirmed`}
            className="rounded-full border border-accent/40 px-2 py-0.5 text-xs text-accent"
          >
            {waiting} to confirm
          </span>
        )}

        {thread.description && (
          <span className="hidden min-w-0 flex-1 truncate text-xs text-muted sm:block">
            {thread.description}
          </span>
        )}

        <span className="ml-auto shrink-0 text-xs text-muted">
          {new Date(thread.lastActiveAt).toLocaleDateString("en-GB", {
            day: "numeric",
            month: "short",
          })}
        </span>
      </div>

      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-3 py-3 text-center text-xs text-muted">
          Nothing here yet - drag a capture onto this row.
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

/**
 * Captures Capso thinks are worth another look, above the projects.
 *
 * Three rules from `drafts/brand/GUIDELINES.html`, all load-bearing:
 * every card states its reason, there is no badge and no count, and nothing
 * renders at all when there is nothing to say. An empty shelf is information;
 * an empty shelf with a heading over it is furniture.
 *
 * Opening a capture records a revisit, which is exactly what removes it from
 * the next call to `resurface()` — so the only two ways off this shelf are the
 * two things the user might genuinely want to do, and neither needs a dismiss
 * button that would need somewhere to store its state.
 */
function ResurfaceShelf({ items }: { items: { s: Screenshot; reason: string }[] }) {
  if (items.length === 0) return null;

  return (
    <section aria-labelledby="resurface-heading" className="space-y-2">
      <h2 id="resurface-heading" className="text-xs uppercase tracking-wide text-muted">
        Worth another look
      </h2>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {items.map(({ s, reason }) => (
          <Link
            key={s.id}
            href={`/s/${s.id}`}
            className="flex gap-3 rounded-xl bg-surface p-2 ring-1 ring-line hover:ring-accent/60"
          >
            <span className="w-16 shrink-0">
              <Thumb s={s} box="4 / 3" />
            </span>
            <span className="min-w-0 flex-1 py-0.5">
              <span className="block truncate text-sm font-medium">{s.title}</span>
              {/* Mandatory. A recommendation the user cannot interrogate is one
                  they can neither trust nor dismiss. */}
              <span className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted">
                {reason}
              </span>
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex rounded-full border border-line bg-surface p-0.5" role="group" aria-label={label}>
      {options.map(([key, label]) => (
        <button
          key={key}
          onClick={() => withTransition(() => onChange(key))}
          className={`min-h-11 rounded-full px-3 text-xs ${
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
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => withTransition(() => onChange(e.target.value))}
      className="min-h-11 rounded-full border border-line bg-surface px-3 text-xs"
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
