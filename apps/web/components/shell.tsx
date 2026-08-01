"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useStore } from "@/lib/store/provider";
import { CaptureLayer } from "@/components/capture";
import { CommandPalette } from "@/components/palette";
import { ShortcutSheet } from "@/components/shortcuts";
import { FirstRun } from "@/components/first-run";
import { DropZone, useDragCount } from "@/components/ui";
import { useMoveCaptures } from "@/lib/move";

/**
 * Sidebar: Inbox pinned above projects, no folder tree. Project rows are drop
 * targets — dragging a card onto one files it (07: adjusting is always ≤2 steps).
 */
export function Shell({ children }: { children: React.ReactNode }) {
  const { ready, loadError, needsSetup, inbox, threads, byThread, addThread, reset, clearSamples } =
    useStore();
  const [adding, setAdding] = useState(false);
  const [palette, setPalette] = useState(false);
  const [nav, setNav] = useState(false);
  const [keys, setKeys] = useState(false);
  const move = useMoveCaptures();
  const dragCount = useDragCount();
  const pathname = usePathname();
  const [ai, setAi] = useState<{ configured: boolean; model: string } | null>(null);

  /**
   * The drawer closes when it has been used. Bound to the link groups rather
   * than to the whole panel, because "+ New project" and the two destructive
   * links also live in there and must survive being clicked.
   */
  const dismissNav = () => setNav(false);

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
        return;
      }
      // `?` opens the keyboard reference — but not while the user is typing one
      // into a project name or a note.
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.key === "?") {
        e.preventDefault();
        setKeys((k) => !k);
      }
      if (e.key === "Escape") setKeys(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /**
   * An unreadable library is the one state that must never hide behind a
   * skeleton — a shimmer that never resolves is indistinguishable from a slow
   * load, and the user has no way to learn that closing another tab fixes it.
   */
  if (loadError)
    return (
      <div className="flex min-h-screen items-center justify-center px-6">
        <div className="max-w-sm space-y-3 text-center">
          <p className="text-sm font-semibold tracking-tight">Capso can’t open your library</p>
          <p className="text-xs leading-relaxed text-muted">{loadError}</p>
          <button
            onClick={() => window.location.reload()}
            className="rounded-md bg-accent px-3 py-1.5 text-xs text-accent-ink"
          >
            Reload
          </button>
        </div>
      </div>
    );

  // One idea per screen (15 §onboarding): during setup there is no sidebar, no
  // search bar and no capture button to compete with the single decision.
  //
  // `/extension` is exempt. It is a static download page that depends on no
  // library state, and the takeover is route-independent — so on a fresh
  // browser the page telling you how to install the extension was replaced by a
  // question about which projects to create, with no way through to it.
  if (ready && needsSetup && pathname !== "/extension")
    return (
      <div className="min-h-screen px-6">
        <p className="py-4 text-sm font-semibold tracking-tight">Capso</p>
        <FirstRun />
      </div>
    );

  return (
    <div className="flex min-h-screen">
      {/* Below md the sidebar was `hidden` with nothing replacing it, so Inbox,
          Search, Memory, every project and "+ New project" were unreachable on a
          phone. Shown as a drawer rather than duplicated into a bottom bar: one
          source of navigation, and no collision with the capture buttons pinned
          to the bottom-right corner. */}
      {nav && (
        <div
          onClick={() => setNav(false)}
          className="capso-fade fixed inset-0 z-30 bg-black/30 backdrop-blur-sm md:hidden"
        />
      )}
      <aside
        className={`${
          nav ? "fixed inset-y-0 left-0 z-40 overflow-y-auto bg-background" : "hidden"
        } w-56 shrink-0 border-r border-line px-3 py-4 md:static md:block md:overflow-visible`}
      >
        <Link
          href="/"
          onClick={dismissNav}
          className="mb-6 block px-2 text-sm font-semibold tracking-tight"
        >
          Capso
        </Link>

        <nav onClick={dismissNav} className="space-y-0.5">
          <Row href="/inbox" label="Inbox" badge={ready ? inbox.length : undefined} />
          {/* The sweep used to be reachable only from a banner gated at three
              pending captures, so with two you could not get to it at all, and
              once its toast was dismissed there was no way back. */}
          <Row href="/review" label="Review" />
          <Row href="/" label="All captures" />
          <Row href="/search" label="Search" />
          <Row href="/memory" label="Memory" />
          <Row href="/extension" label="Get extension" />
        </nav>

        <p className="mt-6 mb-1 flex items-center gap-2 px-2 text-[11px] uppercase tracking-wide text-muted">
          Projects
          {dragCount > 0 && (
            <span className="capso-fade rounded-full bg-accent px-1.5 py-0.5 text-[11px] text-accent-ink">
              drop {dragCount}
            </span>
          )}
        </p>
        <nav onClick={dismissNav} className="space-y-0.5">
          {threads.map((t) => (
            <DropZone
              key={t.id}
              armed={dragCount > 0}
              onDropIds={(ids) => void move(t.id, ids)}
            >
              <Row
                href={`/threads/${t.id}`}
                label={t.name}
                badge={byThread(t.id).length}
                title={t.description || undefined}
              />
            </DropZone>
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
            className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-1 text-sm"
          />
        ) : (
          <button
            onClick={() => setAdding(true)}
            className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-sm text-muted hover:bg-surface"
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

        <div className="mt-2 flex flex-col items-start gap-1 px-2 text-[11px] text-muted">
          {/* `?` cannot teach itself. */}
          <button onClick={() => setKeys(true)} className="hover:text-accent">
            Keyboard shortcuts
          </button>
          <button
            onClick={() =>
              confirm("Delete the sample captures and keep only your own screenshots?") &&
              void clearSamples()
            }
            className="hover:text-accent"
          >
            Use only my screenshots
          </button>
          <button
            onClick={() => confirm("Reset demo data?") && void reset()}
            className="hover:text-accent"
          >
            Reset demo data
          </button>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-line bg-background px-6 py-3">
          <button
            onClick={() => setNav(true)}
            aria-label="Open navigation"
            aria-expanded={nav}
            className="shrink-0 rounded-md border border-line px-2 py-1.5 text-sm leading-none md:hidden"
          >
            ☰
          </button>
          <button
            onClick={() => setPalette(true)}
            className="flex w-full max-w-2xl items-center rounded-lg border border-line bg-surface px-4 py-2.5 text-sm text-muted"
          >
            Search your memory…
            <kbd className="ml-auto hidden rounded border border-line px-1.5 py-0.5 text-[11px] sm:block">
              ⌘K
            </kbd>
          </button>
        </header>
        <main className="px-6 py-6">{children}</main>
      </div>
      <CaptureLayer />
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
      <ShortcutSheet open={keys} onClose={() => setKeys(false)} />
    </div>
  );
}

function Row({
  href,
  label,
  badge,
  title,
}: {
  href: string;
  label: string;
  badge?: number;
  title?: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-surface"
    >
      {/* `title` sits on the label, not the link: on the anchor it would replace
          the accessible name, so the row would announce its description instead
          of the project it goes to. */}
      <span className="truncate" title={title}>
        {label}
      </span>
      {badge !== undefined && <span className="text-[11px] text-muted">{badge}</span>}
    </Link>
  );
}
