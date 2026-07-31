import Link from "next/link";
import { byThread, inbox, threads } from "@/lib/mock";

/**
 * Sidebar: Inbox pinned above projects (Arc/Le Chat pattern), no folder tree.
 * Search is the hero element in the top bar (mymind).
 */
export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-56 shrink-0 border-r border-line px-3 py-4 md:block">
        <Link href="/" className="mb-6 block px-2 text-sm font-semibold tracking-tight">
          Capso
        </Link>

        <nav className="space-y-0.5">
          <NavItem href="/inbox" label="Inbox" badge={inbox.length} />
          <NavItem href="/" label="All captures" />
        </nav>

        <p className="mt-6 mb-1 px-2 text-[11px] uppercase tracking-wide text-muted">Projects</p>
        <nav className="space-y-0.5">
          {threads.map((t) => (
            <NavItem
              key={t.id}
              href={`/threads/${t.id}`}
              label={t.name}
              badge={byThread(t.id).length}
            />
          ))}
        </nav>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-10 border-b border-line bg-background/80 px-6 py-3 backdrop-blur">
          <Link
            href="/search"
            className="block w-full max-w-2xl rounded-lg border border-line bg-surface px-4 py-2.5 text-sm text-muted"
          >
            Search your memory…
          </Link>
        </header>
        <main className="px-6 py-6">{children}</main>
      </div>
    </div>
  );
}

function NavItem({ href, label, badge }: { href: string; label: string; badge?: number }) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between rounded-md px-2 py-1.5 text-[13px] hover:bg-surface"
    >
      <span className="truncate">{label}</span>
      {badge !== undefined && <span className="text-[11px] text-muted">{badge}</span>}
    </Link>
  );
}
