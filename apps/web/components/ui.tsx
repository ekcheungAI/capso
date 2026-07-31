import Link from "next/link";
import { INTENT_LABEL, placeholder, type Intent, type Screenshot } from "@/lib/mock";

export function IntentChip({ intent }: { intent: Intent }) {
  return (
    <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-muted">
      {INTENT_LABEL[intent]}
    </span>
  );
}

/** Only shown for low-confidence items — explains why something landed in the Inbox. */
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

export function FilterPill({
  label,
  removable = false,
}: {
  label: string;
  removable?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-xs">
      {label}
      {removable && <span className="text-muted">×</span>}
    </span>
  );
}

export function Thumb({ s, className = "" }: { s: Screenshot; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- inline SVG data URI, no optimisation to do
    <img
      src={placeholder(s)}
      alt={s.title}
      className={`w-full rounded-lg border border-line ${className}`}
    />
  );
}

export function ScreenshotCard({ s, note }: { s: Screenshot; note?: string }) {
  return (
    <Link
      href={`/threads/${s.threadId ?? "inbox"}`}
      className="group mb-4 block break-inside-avoid rounded-xl bg-surface p-2 ring-1 ring-line transition hover:ring-accent/60"
    >
      <Thumb s={s} />
      <div className="px-1 pt-2 pb-1">
        <p className="truncate text-[13px] font-medium">{s.title}</p>
        {/* Summary reveals on hover and must not reserve space, or every card
            carries two lines of dead air and the grid stops reading as images. */}
        {note ? (
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted">{note}</p>
        ) : (
          <p className="mt-1 line-clamp-2 hidden text-xs leading-relaxed text-muted group-hover:block">
            {s.summary}
          </p>
        )}
      </div>
    </Link>
  );
}

export function Masonry({
  items,
  noteFor,
}: {
  items: Screenshot[];
  noteFor?: (s: Screenshot) => string;
}) {
  return (
    <div className="columns-2 gap-4 lg:columns-3 xl:columns-4">
      {items.map((s) => (
        <ScreenshotCard key={s.id} s={s} note={noteFor?.(s)} />
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
