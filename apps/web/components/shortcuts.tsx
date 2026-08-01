"use client";

/**
 * The keyboard reference, opened with `?`.
 *
 * Triage is keyboard-first by design (15 §interaction principles) and every
 * binding was taught in place — the j/k legend only on Inbox and Review, ⌘K
 * only as a `kbd` in the header, the arrow keys on the detail view nowhere at
 * all. A user who never opened the Inbox never learned the product had a
 * keyboard. One panel, no settings, nothing to configure.
 */

const GROUPS: [string, [string, string][]][] = [
  [
    "Anywhere",
    [
      ["⌘K", "Search your memory"],
      ["?", "This list"],
      ["esc", "Close"],
    ],
  ],
  [
    "Inbox and Review",
    [
      ["j / k", "Move between captures"],
      ["↵", "Confirm the suggestion"],
      ["1–9", "File to that project"],
    ],
  ],
  [
    "A capture",
    [
      ["← / →", "Previous / next"],
      ["esc", "Back to the library"],
    ],
  ],
];

export function ShortcutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;

  return (
    <div
      className="capso-fade fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[12vh] backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="capso-pop w-full max-w-md overflow-hidden rounded-xl bg-surface p-5 shadow-2xl ring-1 ring-line"
      >
        <p className="mb-4 text-sm font-semibold tracking-tight">Keyboard</p>
        <div className="space-y-4">
          {GROUPS.map(([heading, rows]) => (
            <div key={heading}>
              <p className="mb-1.5 text-[11px] uppercase tracking-wide text-muted">{heading}</p>
              <ul className="space-y-1">
                {rows.map(([keys, what]) => (
                  <li key={keys} className="flex items-baseline gap-3 text-xs">
                    <kbd className="min-w-14 shrink-0 rounded border border-line px-1.5 py-0.5 text-center text-[11px] text-muted">
                      {keys}
                    </kbd>
                    <span>{what}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
