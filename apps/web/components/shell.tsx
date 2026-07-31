"use client";

import Link from "next/link";
import { useState } from "react";
import { useStore } from "@/lib/store/provider";
import { CaptureLayer } from "@/components/capture";

/**
 * Sidebar: Inbox pinned above projects, no folder tree. Project rows are drop
 * targets — dragging a card onto one files it (07: adjusting is always ≤2 steps).
 */
export function Shell({ children }: { children: React.ReactNode }) {
  const { ready, inbox, threads, byThread, get, assign, addThread, reset } = useStore();
  const [over, setOver] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const drop = async (threadId: string, id: string) => {
    const s = get(id);
    if (s) await assign(s, threadId, "manual");
    setOver(null);
  };

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-56 shrink-0 border-r border-line px-3 py-4 md:block">
        <Link href="/" className="mb-6 block px-2 text-sm font-semibold tracking-tight">
          Capso
        </Link>

        <nav className="space-y-0.5">
          <Row href="/inbox" label="Inbox" badge={ready ? inbox.length : undefined} />
          <Row href="/" label="All captures" />
          <Row href="/search" label="Search" />
        </nav>

        <p className="mt-6 mb-1 px-2 text-[11px] uppercase tracking-wide text-muted">Projects</p>
        <nav className="space-y-0.5">
          {threads.map((t) => (
            <div
              key={t.id}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(t.id);
              }}
              onDragLeave={() => setOver((o) => (o === t.id ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData("text/capso-id");
                if (id) void drop(t.id, id);
              }}
              className={`rounded-md ${over === t.id ? "ring-2 ring-accent" : ""}`}
            >
              <Row href={`/threads/${t.id}`} label={t.name} badge={byThread(t.id).length} />
            </div>
          ))}
        </nav>

        {adding ? (
          <input
            autoFocus
            placeholder="Project name…"
            onBlur={() => setAdding(false)}
            onKeyDown={async (e) => {
              if (e.key === "Enter" && e.currentTarget.value.trim()) {
                await addThread(e.currentTarget.value.trim());
                setAdding(false);
              }
              if (e.key === "Escape") setAdding(false);
            }}
            className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-1 text-[13px]"
          />
        ) : (
          <button
            onClick={() => setAdding(true)}
            className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-[13px] text-muted hover:bg-surface"
          >
            + New project
          </button>
        )}

        <button
          onClick={() => confirm("Reset demo data?") && void reset()}
          className="mt-8 px-2 text-[11px] text-muted hover:text-accent"
        >
          Reset demo data
        </button>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 border-b border-line bg-background/80 px-6 py-3 backdrop-blur">
          <Link
            href="/search"
            className="block w-full max-w-2xl rounded-lg border border-line bg-surface px-4 py-2.5 text-sm text-muted"
          >
            Search your memory…
          </Link>
        </header>
        <main className="px-6 py-6">{children}</main>
      </div>
      <CaptureLayer />
    </div>
  );
}

function Row({ href, label, badge }: { href: string; label: string; badge?: number }) {
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
