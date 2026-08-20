"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { intent as BRAND_INTENT } from "@capso/shared/tokens";
import { placeholder, type Intent, type Screenshot } from "@/lib/store";
import { allTags } from "@/lib/tags";

// Defined in lib/intent.ts so the retriever can use them without pulling in a
// React module; re-exported here because every UI call site imports them from ui.
export { INTENT_LABEL, INTENTS } from "@/lib/intent";
import { INTENT_LABEL } from "@/lib/intent";

/**
 * Shown wherever an answer could not be written because the model is not
 * configured. One string for one condition: /search and the thread chat used to
 * phrase this two different ways and both named the environment variable, which
 * is error-code language at the surface (15 §UI tone — codes go to tooltips and
 * logs). The variable name still lives on the sidebar status dot's `title`.
 */
export const ANSWERS_OFF = "Answers are off right now. Everything below is still real.";

/**
 * Intent is the only taxonomy the product already computes, and it rendered as
 * seven identical grey chips. The values live in packages/shared/src/tokens.json
 * so the extension, the Mac app and the asset builders all get the same six -
 * see tokens.ts for why they are mid-tone and low-chroma.
 *
 * `other` has no colour by design: it is the absence of a classification, not a
 * seventh category, so it inherits the muted text token.
 */
export const INTENT_COLOR: Record<Intent, string> = {
  ...(BRAND_INTENT as Record<Exclude<Intent, "other">, string>),
  other: "var(--muted)",
};

export function IntentChip({ intent }: { intent: Intent }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-xs text-muted">
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: INTENT_COLOR[intent] }}
      />
      {INTENT_LABEL[intent]}
    </span>
  );
}

/** Shown only where the model was unsure — it explains why a human is needed. */
export function ConfidenceBar({ value }: { value: number }) {
  return (
    <span className="flex items-center gap-1.5" title={`Model confidence ${Math.round(value * 100)}%`}>
      <span className="h-1 w-14 overflow-hidden rounded-full bg-line">
        <span
          className="block h-full rounded-full bg-accent"
          style={{ width: `${Math.round(value * 100)}%` }}
        />
      </span>
      <span className="text-xs tabular-nums text-muted">{Math.round(value * 100)}%</span>
    </span>
  );
}

/**
 * Which variant of a capture to render.
 *
 * `"thumb"` is the 800px WebP and is right for everything that is not the
 * detail hero — grids, the sidebar, the filmstrip, the capture overlay, search
 * citation chips. A 14px citation chip used to decode the same ~500 KB JPEG the
 * zoom view did, because there was only ever one image.
 *
 * Falls back to the original when a row predates thumbs, so old captures keep
 * working rather than rendering a placeholder over real content.
 */
export function imageFor(s: Screenshot, size: "thumb" | "full" = "full") {
  if (size === "thumb" && s.thumbDataUrl) return s.thumbDataUrl;
  // `imageDataUrl` is null on rows whose original lives in the `images` store,
  // so the thumb is the fallback rather than the placeholder — a detail view
  // that has not loaded its original yet shows the 800px version, not a
  // wireframe over real content.
  return s.imageDataUrl ?? s.thumbDataUrl ?? placeholder(s);
}

export function Thumb({
  s,
  className = "",
  size = "thumb",
  box,
}: {
  s: Screenshot;
  className?: string;
  size?: "thumb" | "full";
  /**
   * Render into a fixed-aspect box instead of at the capture's own proportions.
   *
   * Required wherever captures are listed in rows. `h-auto w-full` lets the
   * image set its own height, and a phone screenshot of a long scrolling list is
   * around 1:5 — in a 112px-wide Inbox row that is a 560px-tall row, so one
   * capture owns the whole viewport and the keyboard triage it is built for
   * becomes scrolling. Cropped from the top, because the top of a screenshot is
   * the part that identifies it.
   */
  box?: string;
}) {
  const img = (
    // eslint-disable-next-line @next/next/no-img-element -- data URIs / IndexedDB blobs, nothing to optimise
    <img
      src={imageFor(s, size)}
      alt={s.title}
      // Intrinsic size reserves the box before the image decodes, so a grid of
      // mixed-aspect captures stops jumping as it loads. `aspect` only had three
      // buckets and could not do this.
      width={s.width ?? undefined}
      height={s.height ?? undefined}
      loading="lazy"
      decoding="async"
      className={
        box
          ? "h-full w-full object-cover object-top"
          : `h-auto w-full rounded-lg border border-line ${className}`
      }
    />
  );

  if (!box) return img;
  return (
    <span
      style={{ aspectRatio: box }}
      className={`block overflow-hidden rounded-lg border border-line bg-surface ${className}`}
    >
      {img}
    </span>
  );
}

export function ScreenshotCard({
  s,
  note,
  selected,
  onSelect,
  selectedIds,
  suggestion,
  onTagClick,
  activeTag,
}: {
  s: Screenshot;
  note?: string;
  selected?: boolean;
  onSelect?: (id: string) => void;
  selectedIds?: string[];
  /**
   * Present when this capture is sitting in a shelf it has not been confirmed
   * into. The chip is the call to action (15 §card patterns) — filing must not
   * cost a trip to another screen.
   */
  suggestion?: { label: string; onConfirm: () => void };
  /** Makes the card's tags a way to navigate rather than a label to read. */
  onTagClick?: (tag: string) => void;
  activeTag?: string;
}) {
  const processing = s.status === "processing";
  /**
   * Plays the seat once on confirm. The commit still happens immediately -
   * optimistic UI is a requirement (15 §interaction principles), so the motion
   * runs alongside the state change rather than gating it. If the card leaves
   * the list as a result (Inbox), the animation is simply moot; where it stays
   * (the library shelves) it is the moment the capture becomes yours.
   */
  const [seating, setSeating] = useState(false);
  /**
   * Plays the arrival once, and only for a capture that genuinely just landed.
   *
   * Decided on the capture's own age rather than on mount, because every card
   * mounts on every page load — keying off mount would animate the entire grid
   * every time you opened the app, which is the opposite of calm. Eight seconds
   * covers the ingest-to-render path with room for a slow classify, and the
   * initial state is computed once so a re-render cannot replay it.
   */
  const [arriving] = useState(
    () => Date.now() - new Date(s.capturedAt).getTime() < 8_000,
  );

  return (
    <div
      onAnimationEnd={(e) => {
        if (e.animationName.startsWith("capso-seat")) setSeating(false);
      }}
      draggable={!processing}
      onDragStart={(e) => {
        // Carry the whole selection when the dragged card is part of one.
        const payload = selected && selectedIds?.length ? selectedIds.join(",") : s.id;
        e.dataTransfer.setData("text/capso-id", payload);
        e.dataTransfer.effectAllowed = "move";
        e.currentTarget.classList.add("capso-dragging");
        window.dispatchEvent(new CustomEvent("capso:dragcount", { detail: payload.split(",").length }));
      }}
      onDragEnd={(e) => {
        e.currentTarget.classList.remove("capso-dragging");
        window.dispatchEvent(new CustomEvent("capso:dragcount", { detail: 0 }));
      }}
      style={{ viewTransitionName: `capso-${s.id}` }}
      className={`group relative mb-4 break-inside-avoid rounded-xl bg-surface p-2 transition-[box-shadow,transform,opacity] duration-[120ms] ease-out active:cursor-grabbing ${
        processing ? "cursor-default" : "cursor-grab hover:-translate-y-0.5"
      } ${
        selected
          ? "ring-2 ring-accent"
          : suggestion || processing
            ? // Dashed edge = Capso put this here, you did not. The difference
              // has to be visible at grid scale, not only on the card you hover.
              "ring-1 ring-accent/35 ring-dashed hover:ring-accent/70"
            : "ring-1 ring-line hover:ring-accent/60"
      } ${seating ? "capso-seat capso-crimp" : ""} ${arriving ? "capso-arrive" : ""}`}
    >
      {onSelect && !processing && (
        <button
          onClick={() => onSelect(s.id)}
          aria-label={selected ? `Deselect ${s.title}` : `Select ${s.title}`}
          className={`absolute top-3 left-3 z-10 h-11 w-11 rounded-lg border text-xs leading-none ${
            selected
              ? "border-accent bg-accent text-accent-ink"
              : "border-line bg-surface opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
          }`}
        >
          {selected ? "✓" : ""}
        </button>
      )}

      <Link href={`/s/${s.id}`} className="block">
        <div className="relative">
          {/* Capped, not boxed. The gallery is a moodboard and mixed heights are
              the point - but an unbounded card meant a 1:5 phone screenshot ran
              five column-widths tall and pushed everything after it off-screen.
              Cropped from the top, and only when the capture exceeds the cap. */}
          <Thumb s={s} className="max-h-[30rem] object-cover object-top" />
          {/* The image is on screen the moment it is read; this rides its top
              edge while the model is still looking at it (05 §2). */}
          {processing && (
            <span
              aria-hidden
              className="capso-progress absolute inset-x-0 top-0 h-0.5 overflow-hidden rounded-t-lg"
            />
          )}
        </div>
        <div className="px-1 pt-2 pb-1 sm:max-h-0 sm:overflow-hidden sm:py-0 sm:opacity-0 sm:transition-[max-height,opacity,padding] sm:duration-[120ms] sm:group-focus-within:max-h-32 sm:group-focus-within:pt-2 sm:group-focus-within:pb-1 sm:group-focus-within:opacity-100 sm:group-hover:max-h-32 sm:group-hover:pt-2 sm:group-hover:pb-1 sm:group-hover:opacity-100">
          {/* Provenance, before the title. A capture whose classification failed
              or came from demo data must never read as a real one - its text was
              either absent or invented, and it is about to be indexed by search
              either way. */}
          {(s.status === "unprocessed" || s.simulated) && !processing && (
            <p className="mb-1 inline-flex items-center gap-1 rounded-full border border-line px-1.5 py-0.5 text-xs text-muted">
              {s.status === "unprocessed" ? "Not read yet" : "Sample data"}
            </p>
          )}
          <p className="flex items-center gap-1.5 text-sm font-medium">
            {/* Intent is only meaningful once the model has classified it, so the
                dot waits for the card to leave `processing`. Decorative here -
                the full label lives on the detail view and in the Inbox chip. */}
            {!processing && (
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: INTENT_COLOR[s.intent] }}
              />
            )}
            <span className="truncate">
              {processing ? <span className="text-muted">Analysing…</span> : s.title}
            </span>
          </p>
          {note ? (
            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted">{note}</p>
          ) : (
            // Revealed on focus as well as hover: keyboard users reach this card,
            // and a summary that only exists under a pointer is invisible to
            // exactly the people the triage flow is built for.
            !processing && (
              <p className="mt-1 line-clamp-2 hidden text-xs leading-relaxed text-muted group-focus-within:block group-hover:block">
                {s.summary}
              </p>
            )
          )}
        </div>
      </Link>

      {/* Outside the Link, like the confirm row below and for the same reason:
          a button inside an anchor is invalid and swallows the click. Revealed
          on hover or focus so the resting card stays just the screenshot. */}
      {onTagClick && !processing && allTags(s).length > 0 && (
        <div className="flex flex-wrap gap-1 px-1 pt-1 sm:hidden sm:group-focus-within:flex sm:group-hover:flex">
          {allTags(s)
            .slice(0, 4)
            .map((t) => (
              <button
                key={t}
                onClick={() => onTagClick(t)}
                title={`Show everything tagged “${t}”`}
                className={`min-h-11 rounded-full border px-3 text-xs ${
                  t === activeTag
                    ? "border-accent bg-accent text-accent-ink"
                    : "border-line text-muted hover:border-accent hover:text-accent"
                }`}
              >
                {t}
              </button>
            ))}
        </div>
      )}

      {suggestion && !processing && (
        <div className="flex items-center gap-1.5 px-1 pt-1 pb-0.5">
          <button
            onClick={() => {
              setSeating(true);
              suggestion.onConfirm();
            }}
            aria-label={`Confirm ${s.title} in ${suggestion.label}`}
            className="min-h-11 rounded-full bg-accent px-3 text-xs font-medium text-accent-ink"
          >
            ✓ Confirm
          </button>
          <Link
            href={`/s/${s.id}`}
            aria-label={`Move ${s.title} to a different project`}
            className="flex min-h-11 items-center rounded-full border border-line px-3 text-xs text-muted hover:border-accent hover:text-accent"
          >
            Move to…
          </Link>
          <span className="ml-auto text-xs text-muted tabular-nums">
            {Math.round(s.confidence * 100)}%
          </span>
        </div>
      )}
    </div>
  );
}

export function Masonry({
  items,
  noteFor,
  selected,
  onSelect,
  suggestionFor,
  onTagClick,
  activeTag,
}: {
  items: Screenshot[];
  noteFor?: (s: Screenshot) => string;
  selected?: Set<string>;
  onSelect?: (id: string) => void;
  suggestionFor?: (s: Screenshot) => { label: string; onConfirm: () => void } | undefined;
  onTagClick?: (tag: string) => void;
  activeTag?: string;
}) {
  return (
    <div className="columns-1 gap-4 sm:columns-2 lg:columns-3 xl:columns-4">
      {items.map((s) => (
        <ScreenshotCard
          key={s.id}
          s={s}
          note={noteFor?.(s)}
          selected={selected?.has(s.id)}
          onSelect={onSelect}
          selectedIds={selected ? [...selected] : undefined}
          suggestion={suggestionFor?.(s)}
          onTagClick={onTagClick}
          activeTag={activeTag}
        />
      ))}
    </div>
  );
}

/**
 * How many cards are currently being dragged, broadcast by ScreenshotCard.
 * Every potential target uses it to advertise itself the moment a drag starts,
 * so the user sees where a card *can* go before hunting for it.
 */
export function useDragCount() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const on = (e: Event) => setCount((e as CustomEvent<number>).detail);
    window.addEventListener("capso:dragcount", on);
    return () => window.removeEventListener("capso:dragcount", on);
  }, []);
  return count;
}

/**
 * A place a capture can be dropped — sidebar project rows and library shelves
 * behave identically, so the behaviour lives once. `lift` is off for wide
 * targets where the scale-up in `.capso-drop-active` would overflow the column.
 */
export function DropZone({
  armed,
  onDropIds,
  lift = true,
  className = "",
  children,
}: {
  armed: boolean;
  onDropIds: (ids: string[]) => void;
  lift?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const [over, setOver] = useState(false);
  /**
   * Set for one beat after a drop so the target's lid can seal. Cleared on a
   * timer rather than animationend because the animation lives on a descendant
   * this component does not own.
   */
  const [crimping, setCrimping] = useState(false);

  return (
    <div
      // Data attributes rather than a render prop: the only consumer is CSS,
      // and threading state through children would make every call site of
      // DropZone aware of a detail that is purely presentational.
      data-armed={armed || undefined}
      data-over={over || undefined}
      data-crimp={crimping || undefined}
      onDragOver={(e) => {
        // Ignore file drags — those belong to the global capture layer.
        if (!e.dataTransfer.types.includes("text/capso-id")) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const ids = e.dataTransfer.getData("text/capso-id").split(",").filter(Boolean);
        if (ids.length > 0) {
          setCrimping(true);
          window.setTimeout(() => setCrimping(false), 260);
          onDropIds(ids);
        }
      }}
      className={`capso-drop rounded-md ${
        over
          ? `bg-accent/10 ring-2 ring-accent ${lift ? "capso-drop-active" : ""}`
          : armed
            ? "ring-1 ring-dashed ring-accent/30"
            : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * The receipt. One line, four true numbers — no "0 lost" counter, because
 * delete is a hard delete (10_DATA_MODEL §retention) and a number we cannot
 * measure is not reassurance, it's decoration.
 */
export function LedgerStrip({
  captured,
  filed,
  projects,
  waiting,
  archived,
}: {
  captured: number;
  filed: number;
  projects: number;
  waiting: number;
  archived: number;
}) {
  return (
    <p className="text-xs text-muted">
      <span className="font-medium text-foreground tabular-nums">{captured} captured</span>
      {" · "}
      {/* `projects` counts the projects that EXIST. It used to count only those
          containing a filed capture, so a fresh starter kit with everything
          still unconfirmed read "0 projects" and looked like setup had failed. */}
      <span className="tabular-nums">{filed}</span> confirmed in{" "}
      <span className="tabular-nums">{projects}</span> project{projects === 1 ? "" : "s"}
      {waiting > 0 && (
        <>
          {" · "}
          <Link href="/inbox" className="inline-flex min-h-11 items-center underline underline-offset-2 sm:min-h-0">
            {waiting} waiting
          </Link>
        </>
      )}
      {archived > 0 && <> · {archived} archived</>}
      <span className="ml-2 text-muted">Everything you&apos;ve captured is in here.</span>
    </p>
  );
}

/**
 * Warm, instructive, exactly one action (15 §empty states).
 *
 * `action` is a node rather than a string because it used to render as bare
 * accent-coloured text: copy like "Back to the library" looked exactly like a
 * link and did nothing, and /review had to add a second real link underneath to
 * compensate. Pass a `<Link>` or a `<button>` when there is somewhere to go, a
 * string when the line is only a statement.
 */
export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-line px-6 py-16 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted">{body}</p>
      {action !== undefined && (
        <p className="mt-4 text-xs text-muted [&_a]:inline-flex [&_a]:min-h-11 [&_a]:items-center [&_a]:justify-center [&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2 [&_button]:inline-flex [&_button]:min-h-11 [&_button]:items-center [&_button]:justify-center [&_button]:text-accent [&_button]:underline [&_button]:underline-offset-2">
          {action}
        </p>
      )}
    </div>
  );
}

/** Loading placeholder that keeps the grid's shape instead of collapsing to text. */
export function SkeletonGrid({ count = 8 }: { count?: number }) {
  const heights = [180, 260, 210, 300, 190, 240, 280, 200];
  return (
    <div className="columns-2 gap-4 lg:columns-3 xl:columns-4" aria-busy="true" aria-label="Loading captures">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="mb-4 break-inside-avoid rounded-xl bg-surface p-2 ring-1 ring-line">
          <div
            className="capso-skeleton rounded-lg"
            style={{ height: heights[i % heights.length] }}
          />
          <div className="capso-skeleton mt-2 h-3 w-2/3 rounded" />
        </div>
      ))}
    </div>
  );
}
