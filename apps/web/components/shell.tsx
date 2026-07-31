"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useStore } from "@/lib/store/provider";
import { CaptureLayer } from "@/components/capture";
import { CommandPalette } from "@/components/palette";
import { useToast } from "@/components/toast";

/**
 * Sidebar: Inbox pinned above projects, no folder tree. Project rows are drop
 * targets — dragging a card onto one files it (07: adjusting is always ≤2 steps).
 */
export function Shell({ children }: { children: React.ReactNode }) {
  const { ready, inbox, threads, byThread, get, assign, addThread, reset } = useStore();
  const [over, setOver] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [palette, setPalette] = useState(false);
  const toast = useToast();
  const [dragCount, setDragCount] = useState(0);
  const [ai, setAi] = useState<{ configured: boolean; model: string } | null>(null);

  // While a drag is in flight the sidebar advertises itself as a target.
  useEffect(() => {
    const onCount = (e: Event) => setDragCount((e as CustomEvent<number>).detail);
    window.addEventListener("capso:dragcount", onCount);
    return () => window.removeEventListener("capso:dragcount", onCount);
  }, []);

  useEffect(() => {
    fetch("/api/classify")
      .then((r) => r.json())
      .then(setAi)
      .catch(() => setAi({ configured: false, model: "" }));
  }, []);

  // ⌘K from anywhere — the fastest path from "I remember something" to the capture.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const drop = async (threadId: string, payload: string) => {
    const ids = payload.split(",").filter(Boolean);
    const moved = ids.map((id) => get(id)).filter((s): s is NonNullable<typeof s> => Boolean(s));
    setOver(null);
    setDragCount(0);
    if (moved.length === 0) return;

    const previous = moved.map((s) => [s, s.threadId] as const);
    const run = () => Promise.all(moved.map((s) => assign(s, threadId, "manual")));

    // View Transitions make the cards travel to their new positions instead of
    // snapping. Guarded because Safari/Firefox lag on support.
    if (typeof document.startViewTransition === "function") {
      await new Promise<void>((res) =>
        document.startViewTransition!(async () => {
          await run();
          res();
        }),
      );
    } else {
      await run();
    }

    const name = threads.find((t) => t.id === threadId)?.name ?? "Inbox";
    toast(`Moved ${moved.length > 1 ? `${moved.length} captures` : "1 capture"} to ${name}`, () => {
      for (const [s, prev] of previous) void assign(s, prev, "manual");
    });
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
          <Row href="/memory" label="Memory" />
        </nav>

        <p className="mt-6 mb-1 flex items-center gap-2 px-2 text-[11px] uppercase tracking-wide text-muted">
          Projects
          {dragCount > 0 && (
            <span className="capso-fade rounded-full bg-accent px-1.5 py-0.5 text-[10px] text-white">
              drop {dragCount}
            </span>
          )}
        </p>
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
              className={`capso-drop rounded-md ${
                over === t.id ? "capso-drop-active bg-accent/10 ring-2 ring-accent" : ""
              } ${dragCount > 0 && over !== t.id ? "ring-1 ring-dashed ring-accent/30" : ""}`}
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

        {ai && (
          <p
            className="mt-8 px-2 text-[11px] text-muted"
            title={
              ai.configured
                ? `Classifications come from ${ai.model}`
                : "Set MINIMAX_TEXT_API_KEY in apps/web/.env.local for real classifications"
            }
          >
            <span
              className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full ${
                ai.configured ? "bg-accent" : "bg-muted"
              }`}
            />
            {ai.configured ? ai.model : "AI: sample data"}
          </p>
        )}

        <button
          onClick={() => confirm("Reset demo data?") && void reset()}
          className="mt-2 px-2 text-[11px] text-muted hover:text-accent"
        >
          Reset demo data
        </button>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 border-b border-line bg-background px-6 py-3">
          <button
            onClick={() => setPalette(true)}
            className="flex w-full max-w-2xl items-center rounded-lg border border-line bg-surface px-4 py-2.5 text-sm text-muted"
          >
            Search your memory…
            <kbd className="ml-auto rounded border border-line px-1.5 py-0.5 text-[10px]">⌘K</kbd>
          </button>
        </header>
        <main className="px-6 py-6">{children}</main>
      </div>
      <CaptureLayer />
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
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
