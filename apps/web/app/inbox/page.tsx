import { inbox, threadName } from "@/lib/mock";
import { ConfidenceBar, EmptyState, IntentChip, Thumb } from "@/components/ui";

/**
 * Inbox triage. Three verbs only — Confirm / Ignore / Try again (Notion Mail).
 * Confidence is shown here and nowhere else: it explains why the item needs a human.
 */
export default function InboxPage() {
  if (inbox.length === 0) {
    return (
      <EmptyState
        title="Inbox is clear"
        body="Captures the AI was confident about went straight to their project. Anything uncertain waits here."
        action="Take a screenshot with ⌃⇧C"
      />
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-sm font-semibold">Inbox</h1>
        <p className="mt-1 text-xs text-muted">
          {inbox.length} captures need a decision. Everything above 80% confidence was filed automatically.
        </p>
      </div>

      <ul className="space-y-3">
        {inbox.map((s) => (
          <li
            key={s.id}
            className="flex gap-4 rounded-xl bg-surface p-3 ring-1 ring-line"
          >
            <div className="w-28 shrink-0">
              <Thumb s={s} />
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="truncate text-[13px] font-medium">{s.title}</p>
                <IntentChip intent={s.intent} />
                <ConfidenceBar value={s.confidence} />
              </div>

              <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted">{s.summary}</p>

              <p className="mt-2 text-xs">
                <span className="text-muted">Suggested project — </span>
                <span className="font-medium">{threadName(s.suggestedThreadId ?? "")}</span>
              </p>

              <div className="mt-3 flex flex-wrap gap-2">
                <button className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white">
                  Confirm
                </button>
                <button className="rounded-md border border-line px-3 py-1.5 text-xs">
                  Change project
                </button>
                <button className="rounded-md border border-line px-3 py-1.5 text-xs">
                  Try again
                </button>
                <button className="rounded-md px-3 py-1.5 text-xs text-muted">Ignore</button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
