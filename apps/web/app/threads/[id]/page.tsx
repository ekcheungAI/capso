import { byThread, threadName } from "@/lib/mock";
import { EmptyState, IntentChip, Thumb } from "@/components/ui";

/**
 * Thread view: transcript ‖ sources rail (Front three-pane, ChatGPT sources panel).
 * Citations appear inline as chips AND in the rail — the answer never claims
 * something without naming which captures it read (AC-CHAT-02).
 */
export default async function ThreadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const shots = byThread(id);

  if (shots.length === 0) {
    return (
      <EmptyState
        title="Nothing in this project yet"
        body="Captures land here once you confirm the suggestion on the overlay, or move them from the Inbox."
        action="Capture something with ⌃⇧C"
      />
    );
  }

  const cited = shots.slice(0, 2);

  return (
    <div className="flex gap-6">
      <div className="min-w-0 flex-1 space-y-5">
        <div>
          <h1 className="text-sm font-semibold">{threadName(id)}</h1>
          <p className="mt-1 text-xs text-muted">{shots.length} captures in this project</p>
        </div>

        {/* Pinned strip of everything the thread knows about */}
        <div className="flex gap-2 overflow-x-auto pb-1">
          {shots.map((s) => (
            <div key={s.id} className="w-24 shrink-0">
              <Thumb s={s} />
            </div>
          ))}
        </div>

        <div className="space-y-4 border-t border-line pt-5">
          <Bubble side="user">
            <p>What&apos;s the common pattern across the pricing pages I saved?</p>
          </Bubble>

          <Bubble side="ai">
            {/* Retrieval status line (Perplexity) — latency made visible */}
            <p className="mb-2 text-[11px] text-muted">
              Searched your memory · {shots.length} captures read
            </p>
            <p>
              Two of them put the savings message on the billing toggle itself rather than
              beneath the price
              {cited.map((s) => (
                <Cite key={s.id} n={s.title} />
              ))}
              . Both also lead with the middle tier — the annual price is the default state, so
              the discount reads as the normal price rather than a promotion.
            </p>
            <p className="mt-2">
              The one exception is the changelog capture, which isn&apos;t a pricing page at all —
              worth moving to another project.
            </p>
          </Bubble>
        </div>

        <div className="rounded-lg border border-line bg-surface px-4 py-3 text-sm text-muted">
          Ask about this project…
        </div>
      </div>

      <aside className="hidden w-64 shrink-0 lg:block">
        <p className="mb-2 text-[11px] uppercase tracking-wide text-muted">
          Sources · {cited.length}
        </p>
        <ul className="space-y-2">
          {cited.map((s) => (
            <li key={s.id} className="rounded-lg bg-surface p-2 ring-1 ring-line">
              <Thumb s={s} />
              <p className="mt-1.5 truncate text-[11px] font-medium">{s.title}</p>
              <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted">
                {s.ocrExcerpt}
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

function Bubble({ side, children }: { side: "user" | "ai"; children: React.ReactNode }) {
  const user = side === "user";
  return (
    <div className={user ? "flex justify-end" : ""}>
      <div
        className={`max-w-xl rounded-xl px-4 py-3 text-sm leading-relaxed ${
          user ? "bg-surface ring-1 ring-line" : ""
        }`}
      >
        {children}
      </div>
    </div>
  );
}

function Cite({ n }: { n: string }) {
  const short = n.split(" — ")[0];
  return (
    <span className="mx-1 inline-flex items-center rounded border border-line px-1.5 py-0.5 align-middle text-[11px] text-muted">
      {short}
    </span>
  );
}

export function generateStaticParams() {
  return ["pricing-redesign", "onboarding-teardown", "capso-bugs", "q3-launch", "inbox"].map(
    (id) => ({ id }),
  );
}

export const dynamicParams = false;
