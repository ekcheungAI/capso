"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowRight, CheckCircle, MagnifyingGlass, Plus, SealCheck, Sparkle, X } from "@phosphor-icons/react";
import { FirstCapture } from "@/components/first-capture";
import { CapsoMark, fillFor } from "@/components/mark.generated";
import { useToast } from "@/components/toast";
import { SkeletonGrid, Thumb } from "@/components/ui";
import { resurface } from "@/lib/resurface";
import type { Screenshot, Thread } from "@/lib/store";
import { useStore } from "@/lib/store/provider";

export default function HomePage() {
  const { ready, screenshots, inbox, threads, byThread, threadName, revisits, assign, stage } = useStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filingId, setFilingId] = useState<string | null>(null);
  const [drawerItem, setDrawerItem] = useState<Screenshot | null>(null);
  const [mountedAt] = useState(() => Date.now());
  const toast = useToast();

  const tray = useMemo(
    () => [...inbox].sort(byNewest).slice(0, 4),
    [inbox],
  );

  const activeProjects = useMemo(
    () =>
      threads
        .filter((thread) => !thread.archived)
        .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
        .slice(0, 3),
    [threads],
  );

  const worthPulling = useMemo(
    () => resurface(screenshots, revisits, threadName, 3, mountedAt),
    [screenshots, revisits, threadName, mountedAt],
  );

  const selected = tray.find((s) => s.id === selectedId) ?? null;
  // Older local rows can carry an empty string from the pre-nullable schema.
  // Treat it like no assignment so a loose capture can still fall back to the
  // most recently active real project.
  const requestedDestinationId = selected?.threadId || selected?.suggestedThreadId || null;
  // A removed/reset project can leave an old local capture pointing at an id
  // that no longer resolves. The tray should still offer a real destination.
  const destination =
    threads.find((thread) => thread.id === requestedDestinationId && !thread.archived) ??
    activeProjects[0] ??
    null;

  if (!ready) return <SkeletonGrid />;

  // Was `screenshots.length === 0 && threads.length === 0`, which a role template
  // makes false the instant it creates projects — so this welcome was unreachable
  // for nearly every new user, who landed on an empty "Today's tray" instead.
  // `stage` asks the question that was actually meant: has this person captured
  // anything yet? See lib/onboarding.ts.
  if (stage === "first_capture") return <FirstCapture variant="page" />;

  const selectCapture = (id: string) => {
    setSelectedId((current) => (current === id ? null : id));
  };

  const fileCapture = async (capture: Screenshot, project: Thread) => {
    if (filingId) return;
    setFilingId(capture.id);
    const previousThreadId = capture.threadId;
    try {
      await assign(
        capture,
        project.id,
        capture.suggestedThreadId === project.id ? "inbox_triage" : "manual",
      );
      setSelectedId(null);
      toast(`Filed in ${project.name}`, () => {
        void assign(capture, previousThreadId, "manual");
      });
    } catch {
      toast("Couldn’t file this capture. Nothing was changed.");
    } finally {
      setFilingId(null);
    }
  };

  const openSearch = () => window.dispatchEvent(new CustomEvent("capso:open-palette"));
  const openImport = () => document.getElementById("capso-import-input")?.click();

  return (
    <div className="mx-auto w-full max-w-[1740px] px-5 py-7 sm:px-8 lg:px-12">
      <header className="mb-7 flex items-start justify-between gap-5">
        <div>
          <h1 className="text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">Today’s tray</h1>
          <p className="mt-1.5 text-sm text-muted">Loose captures become calm, retrievable memory.</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/inbox"
            className="hidden h-11 items-center gap-2 rounded-full border border-line bg-surface px-4 text-xs font-medium text-muted sm:flex"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-danger" />
            {inbox.length} waiting
          </Link>
          <button
            type="button"
            onClick={openSearch}
            className="hidden h-11 w-56 items-center gap-2 rounded-full border border-line bg-surface px-4 text-sm text-muted md:flex"
          >
            <MagnifyingGlass size={18} /> Search
          </button>
          <button
            type="button"
            onClick={openImport}
            aria-label="Import a capture"
            className="grid h-11 w-11 place-items-center rounded-full bg-accent text-accent-ink"
          >
            <Plus size={20} />
          </button>
        </div>
      </header>

      {/* Samples are on screen, so the full-page welcome has nowhere to go. One
          line instead, and it removes itself on the first real capture — nothing
          to dismiss, per doc 15's ban on checklists that outlive onboarding. */}
      {stage === "nudge" && <FirstCapture variant="nudge" />}

      <section aria-labelledby="tray-heading">
        <div className="mb-4 flex items-end justify-between gap-4">
          <div>
            <h2 id="tray-heading" className="text-xl font-semibold tracking-tight">Loose captures</h2>
            <p className="mt-1 text-xs text-muted">Pick one to watch Capso understand and file it.</p>
          </div>
          {tray.length > 0 && (
            <Link href="/inbox" className="inline-flex min-h-11 items-center px-2 text-xs font-medium text-muted hover:text-foreground">
              Review all
            </Link>
          )}
        </div>

        {tray.length > 0 ? (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {tray.map((capture) => (
              <CaptureTile
                key={capture.id}
                capture={capture}
                selected={capture.id === selected?.id}
                destination={capture.id === selected?.id ? destination : null}
                filing={capture.id === filingId}
                onSelect={() => selectCapture(capture.id)}
                onFile={destination ? () => void fileCapture(capture, destination) : undefined}
              />
            ))}
          </div>
        ) : (
          <div className="flex min-h-32 items-center gap-3 rounded-2xl border border-dashed border-line bg-surface/35 px-5 py-4 text-muted">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface text-foreground shadow-sm">
              <CheckCircle size={19} weight="fill" />
            </span>
            <span>
              <strong className="block text-sm font-semibold text-foreground">Tray clear</strong>
              <span className="mt-1 block text-xs">New screenshots will wait here only when Capso needs your call.</span>
            </span>
          </div>
        )}
      </section>

      <section aria-labelledby="memory-heading" className="mt-7">
        <div className="mb-4 flex items-end justify-between gap-4">
          <div>
            <h2 id="memory-heading" className="text-xl font-semibold tracking-tight">Your organised memory</h2>
            <p className="mt-1 text-xs text-muted">Projects stay calm. The useful thing is always one pull away.</p>
          </div>
          <span className="hidden items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-2 text-xs font-medium text-muted sm:inline-flex">
            <Sparkle size={14} weight="fill" /> Organised around you
          </span>
        </div>

        <div className="grid gap-2.5">
          {activeProjects.map((thread) => {
            const items = byThread(thread.id).sort(byNewest);
            return (
              <ProjectRow
                key={thread.id}
                thread={thread}
                items={items}
                onPull={(item) => setDrawerItem(item)}
              />
            );
          })}
        </div>

        {threads.filter((thread) => !thread.archived).length > 3 && (
          <Link href="/library" className="mt-2 inline-flex min-h-11 items-center gap-2 px-2 text-xs font-medium text-muted hover:text-foreground">
            Browse all projects <ArrowRight size={14} />
          </Link>
        )}
      </section>

      <EvidenceDrawer
        item={drawerItem}
        reason={worthPulling.find(({ s }) => s.id === drawerItem?.id)?.reason}
        thread={threads.find((candidate) => candidate.id === drawerItem?.threadId) ?? null}
        onClose={() => setDrawerItem(null)}
      />
    </div>
  );
}

function CaptureTile({
  capture,
  selected,
  destination,
  filing,
  onSelect,
  onFile,
}: {
  capture: Screenshot;
  selected: boolean;
  destination: Thread | null;
  filing: boolean;
  onSelect: () => void;
  onFile?: () => void;
}) {
  return (
    <article
      className={`capso-capture-tile group overflow-hidden rounded-2xl border bg-surface text-left ${
        selected ? "border-accent shadow-md" : "border-line"
      }`}
    >
      <div className="relative">
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={selected}
          aria-label={`${capture.title}, ${sourceLabel(capture)}, ${captureTime(capture)}`}
          className="block w-full text-left"
        >
          <Thumb s={capture} box="2.35 / 1" className="rounded-none border-0" />
        </button>
        {selected && (
          <span className="capso-selected-seal pointer-events-none absolute right-2.5 top-2.5 grid h-7 w-7 place-items-center rounded-full bg-surface text-foreground shadow-md">
            <SealCheck size={18} weight="fill" />
          </span>
        )}
        {selected && (
          <div className="capso-tile-decision absolute inset-x-2 bottom-2 flex items-center gap-2 rounded-xl border border-line bg-background/95 p-2 shadow-lg backdrop-blur-sm">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface text-foreground shadow-sm" aria-hidden="true">
              <CapsoMark size={26} fill="some" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-semibold uppercase tracking-[.1em] text-muted">Suggested project</span>
              <strong className="block truncate text-xs">{destination?.name ?? "Choose a project"}</strong>
            </span>
            {destination && onFile ? (
              <button
                type="button"
                onClick={onFile}
                disabled={filing}
                aria-label={`File ${capture.title} in ${destination.name}`}
                className="capso-press min-h-11 shrink-0 rounded-lg bg-accent px-3 text-xs font-semibold text-accent-ink disabled:opacity-60"
              >
                {filing ? "Filing…" : "File here"}
              </button>
            ) : (
              <Link href="/inbox" className="capso-press flex min-h-11 shrink-0 items-center rounded-lg bg-accent px-3 text-xs font-semibold text-accent-ink">
                Choose
              </Link>
            )}
          </div>
        )}
      </div>
      <button type="button" onClick={onSelect} className="grid w-full gap-1 px-3.5 py-3 text-left">
        <strong className="truncate text-sm font-semibold">{capture.title}</strong>
        <span className="text-xs text-muted">{sourceLabel(capture)} · {captureTime(capture)}</span>
      </button>
    </article>
  );
}

function ProjectRow({ thread, items, onPull }: { thread: Thread; items: Screenshot[]; onPull: (item: Screenshot) => void }) {
  const preview = items[0];
  const visible = Math.min(Math.max(items.length, 1), 4);
  return (
    <article className="grid min-h-20 items-center gap-4 rounded-2xl border border-line bg-surface/55 px-5 py-3 transition-colors duration-[var(--dur-press)] ease-out hover:bg-surface md:grid-cols-[minmax(180px,.8fr)_minmax(260px,1.35fr)_124px_52px]">
      <div className="grid gap-1">
        <Link href={`/threads/${thread.id}`} className="inline-flex min-h-11 items-center text-sm font-semibold hover:underline">{thread.name}</Link>
        <span className="text-xs text-muted">{items.length} memories · updated {relativeDay(thread.lastActiveAt)}</span>
      </div>
      <div className="flex items-center gap-2.5 overflow-hidden">
        {Array.from({ length: visible }, (_, index) => (
          <MemoryCapsule
            key={index}
            fill={fillFor(items.length)}
            onClick={preview ? () => onPull(preview) : undefined}
            label={preview ? `Pull a memory from ${thread.name}` : undefined}
          />
        ))}
        {items.length > 4 && <span className="text-xs font-semibold text-muted">+{items.length - 4}</span>}
      </div>
      {preview ? <Thumb s={preview} box="2 / 1" /> : <span className="h-14 rounded-xl border border-dashed border-line" />}
      <Link
        href={`/threads/${thread.id}`}
        aria-label={`Open ${thread.name}`}
        className="inline-flex min-h-11 items-center justify-center text-center text-xs font-semibold text-muted hover:text-foreground"
      >Open</Link>
    </article>
  );
}

function MemoryCapsule({ fill, onClick, label }: { fill: "empty" | "some" | "full"; onClick?: () => void; label?: string }) {
  const className = `grid h-12 w-12 shrink-0 place-items-center rounded-full border border-line bg-background shadow-md${onClick ? " capso-memory-capsule" : ""}`;
  if (!onClick) {
    return <span className={className}><CapsoMark size={39} fill={fill} /></span>;
  }
  return (
    <button type="button" onClick={onClick} aria-label={label} className={className}>
      <CapsoMark size={39} fill={fill} />
    </button>
  );
}

function EvidenceDrawer({ item, reason, thread, onClose }: { item: Screenshot | null; reason?: string; thread: Thread | null; onClose: () => void }) {
  return (
    <aside
      aria-hidden={!item}
      inert={!item}
      className={`capso-evidence-drawer fixed inset-y-4 right-4 z-50 w-[min(420px,calc(100vw-32px))] overflow-y-auto rounded-[22px] border border-line bg-surface p-7 shadow-2xl ${
        item ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-[calc(100%+32px)] opacity-0"
      }`}
    >
      <button type="button" onClick={onClose} aria-label="Close evidence" className="absolute right-5 top-5 grid h-11 w-11 place-items-center rounded-full bg-background text-muted">
        <X size={18} />
      </button>
      <p className="mb-3 text-xs font-bold uppercase tracking-[.14em] text-muted">Worth pulling</p>
      <h2 className="text-2xl font-semibold tracking-tight">Back in context.</h2>
      <p className="mt-2 text-xs leading-relaxed text-muted">The original screenshot, why you saved it, and where it now belongs.</p>
      {item && (
        <>
          <div className="mt-5 overflow-hidden rounded-2xl shadow-lg"><Thumb s={item} box="4 / 3" size="full" /></div>
          <div className="mt-4 flex gap-3 rounded-2xl bg-background p-4 text-foreground">
            <Sparkle size={18} weight="fill" className="mt-0.5 shrink-0" />
            <div>
              <strong className="block text-xs text-foreground">Why Capso kept this</strong>
              <p className="mt-1 text-xs leading-relaxed text-muted">{reason ?? item.whySaved ?? item.summary ?? "It connects to work you have returned to recently."}</p>
            </div>
          </div>
          <dl className="mt-3 text-xs">
            <div className="flex justify-between border-b border-line py-3"><dt className="text-muted">Project</dt><dd className="font-semibold">{thread?.name ?? "Unsorted"}</dd></div>
            <div className="flex justify-between border-b border-line py-3"><dt className="text-muted">Source</dt><dd className="font-semibold">{sourceLabel(item)}</dd></div>
            <div className="flex justify-between border-b border-line py-3"><dt className="text-muted">Captured</dt><dd className="font-semibold">{new Date(item.capturedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</dd></div>
          </dl>
          <Link href={`/s/${item.id}`} className="mt-5 flex min-h-11 items-center justify-center rounded-xl bg-accent text-xs font-semibold text-accent-ink">Open full memory</Link>
        </>
      )}
    </aside>
  );
}

const byNewest = (a: Screenshot, b: Screenshot) => b.capturedAt.localeCompare(a.capturedAt);

function sourceLabel(capture: Screenshot) {
  if (capture.sourceApp) return capture.sourceApp;
  if (capture.source === "extension") return "Browser";
  if (capture.source === "web_upload") return "Import";
  if (capture.source === "clipboard") return "Clipboard";
  if (capture.source === "seed") return "Sample";
  return "Capso";
}

function captureTime(capture: Screenshot) {
  return new Date(capture.capturedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function relativeDay(value: string) {
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return "today";
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
