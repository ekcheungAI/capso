"use client";

import Link from "next/link";
import { placeholder, type Intent, type Screenshot } from "@/lib/store";

export const INTENT_LABEL: Record<Intent, string> = {
  design_inspiration: "Design inspiration",
  ux_bug: "UX bug",
  competitor: "Competitor",
  marketing_hook: "Marketing hook",
  content_idea: "Content idea",
  reference: "Reference",
  other: "Other",
};

export const INTENTS = Object.keys(INTENT_LABEL) as Intent[];

export function IntentChip({ intent }: { intent: Intent }) {
  return (
    <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-muted">
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
      <span className="text-[11px] tabular-nums text-muted">{Math.round(value * 100)}%</span>
    </span>
  );
}

export function FilterPill({ label, removable = false }: { label: string; removable?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-xs">
      {label}
      {removable && <span className="text-muted">×</span>}
    </span>
  );
}

export function imageFor(s: Screenshot) {
  return s.imageDataUrl ?? placeholder(s);
}

export function Thumb({ s, className = "" }: { s: Screenshot; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- data URIs / IndexedDB blobs, nothing to optimise
    <img
      src={imageFor(s)}
      alt={s.title}
      className={`w-full rounded-lg border border-line ${className}`}
    />
  );
}

export function ScreenshotCard({
  s,
  note,
  selected,
  onSelect,
  selectedIds,
}: {
  s: Screenshot;
  note?: string;
  selected?: boolean;
  onSelect?: (id: string) => void;
  selectedIds?: string[];
}) {
  return (
    <div
      draggable
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
      className={`group relative mb-4 cursor-grab break-inside-avoid rounded-xl bg-surface p-2 ring-1 transition-[box-shadow,transform,opacity] duration-[120ms] ease-out hover:-translate-y-0.5 active:cursor-grabbing ${
        selected ? "ring-2 ring-accent" : "ring-line hover:ring-accent/60"
      }`}
    >
      {onSelect && (
        <button
          onClick={() => onSelect(s.id)}
          aria-label={selected ? "Deselect" : "Select"}
          className={`absolute top-3 left-3 z-10 h-5 w-5 rounded-md border text-[11px] leading-none ${
            selected ? "border-accent bg-accent text-white" : "border-line bg-surface opacity-0 group-hover:opacity-100"
          }`}
        >
          {selected ? "✓" : ""}
        </button>
      )}

      <Link href={`/s/${s.id}`} className="block">
        <Thumb s={s} />
        <div className="px-1 pt-2 pb-1">
          <p className="truncate text-[13px] font-medium">{s.title}</p>
          {note ? (
            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted">{note}</p>
          ) : (
            <p className="mt-1 line-clamp-2 hidden text-xs leading-relaxed text-muted group-hover:block">
              {s.summary}
            </p>
          )}
        </div>
      </Link>
    </div>
  );
}

export function Masonry({
  items,
  noteFor,
  selected,
  onSelect,
}: {
  items: Screenshot[];
  noteFor?: (s: Screenshot) => string;
  selected?: Set<string>;
  onSelect?: (id: string) => void;
}) {
  return (
    <div className="columns-2 gap-4 lg:columns-3 xl:columns-4">
      {items.map((s) => (
        <ScreenshotCard
          key={s.id}
          s={s}
          note={noteFor?.(s)}
          selected={selected?.has(s.id)}
          onSelect={onSelect}
          selectedIds={selected ? [...selected] : undefined}
        />
      ))}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action: string }) {
  return (
    <div className="rounded-xl border border-dashed border-line px-6 py-16 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted">{body}</p>
      <p className="mt-4 text-xs text-accent">{action}</p>
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
