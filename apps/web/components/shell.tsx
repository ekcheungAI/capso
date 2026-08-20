"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  Brain,
  Checks,
  DotsThree,
  FolderSimple,
  GearSix,
  House,
  MagnifyingGlass,
  Plus,
  SquaresFour,
  Tray,
  X,
} from "@phosphor-icons/react";
import { CapsoMark, CapsoMarkDefs, fillFor } from "@/components/mark.generated";
import { CaptureLayer } from "@/components/capture";
import { CommandPalette } from "@/components/palette";
import { ShortcutSheet } from "@/components/shortcuts";
import { FirstRun } from "@/components/first-run";
import { DropZone, useDragCount } from "@/components/ui";
import { ImportLocal } from "@/components/import-local";
import { DevicesAndSync } from "@/components/devices-sync";
import { useAccount } from "@/components/account-gate";
import { useToast } from "@/components/toast";
import { useMoveCaptures } from "@/lib/move";
import { useStore } from "@/lib/store/provider";

const NAV_ITEMS = [
  { href: "/", label: "Home", Icon: House },
  { href: "/inbox", label: "Tray", Icon: Tray },
  { href: "/library", label: "Library", Icon: SquaresFour },
  { href: "/search", label: "Search", Icon: MagnifyingGlass },
] as const;

export function Shell({ children }: { children: React.ReactNode }) {
  const { ready, loadError, needsSetup, threads, byThread, addThread, reset, clearSamples } = useStore();
  const account = useAccount();
  const toast = useToast();
  const pathname = usePathname();
  const move = useMoveCaptures();
  const dragCount = useDragCount();
  const [palette, setPalette] = useState(false);
  const [keys, setKeys] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [ai, setAi] = useState<{ configured: boolean } | null>(null);
  const panelTrigger = useRef<HTMLElement | null>(null);

  useEffect(() => {
    fetch("/api/classify")
      .then((response) => response.json())
      .then(setAi)
      .catch(() => setAi({ configured: false }));
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette((open) => !open);
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key === "?") {
        event.preventDefault();
        setKeys((open) => !open);
      }
      if (event.key === "Escape") {
        setKeys(false);
        setProjectsOpen(false);
        setSettingsOpen(false);
      }
    };
    const openPalette = () => setPalette(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("capso:open-palette", openPalette);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("capso:open-palette", openPalette);
    };
  }, []);

  if (loadError) {
    return (
      <div className="flex min-h-screen items-center justify-center px-6">
        <div className="max-w-sm space-y-3 text-center">
          <p className="text-sm font-semibold tracking-tight">Capso can’t open your library</p>
          <p className="text-xs leading-relaxed text-muted">{loadError}</p>
          <button onClick={() => window.location.reload()} className="min-h-11 rounded-xl bg-accent px-4 text-xs text-accent-ink">Reload</button>
        </div>
      </div>
    );
  }

  /**
   * First run covers the route, inside the shell — it used to replace the shell
   * entirely, returning early from here.
   *
   * That early return also skipped `CaptureLayer` (mounted at the bottom of this
   * component), so drop, paste and the Capture dock were all dead on the one
   * screen in the product that says "drop an image anywhere, paste from the
   * clipboard, or press Capture". A user who followed those instructions during
   * first run got nothing.
   *
   * Deliberately a cover and not an `aria-modal` dialog: a focus trap here would
   * need `inert` on the rail, add axe surface, and break interaction principle 2
   * ("nothing blocks capture") in spirit while fixing it in letter.
   */
  const showFirstRun = ready && needsSetup && pathname !== "/extension";

  const closePanels = () => {
    setProjectsOpen(false);
    setSettingsOpen(false);
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <CapsoMarkDefs />

      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[78px] flex-col items-center border-r border-line bg-background px-3 pb-5 pt-5 md:flex">
        <Link href="/" aria-label="Capso home" className="grid h-11 w-11 place-items-center rounded-[14px]" onClick={closePanels}>
          <CapsoMark size={36} fill="full" label="Capso" />
        </Link>

        <nav aria-label="Primary navigation" className="mt-10 grid w-full gap-1.5">
          {NAV_ITEMS.map(({ href, label, Icon }) => (
            <RailLink key={href} href={href} label={label} active={isActive(pathname, href)} onClick={closePanels}>
              <Icon size={21} weight={isActive(pathname, href) ? "fill" : "regular"} />
            </RailLink>
          ))}
          <button
            type="button"
            onClick={(event) => {
              panelTrigger.current = event.currentTarget;
              setProjectsOpen((open) => !open);
              setSettingsOpen(false);
            }}
            aria-label="Projects"
            aria-expanded={projectsOpen}
            aria-controls="capso-projects-panel"
            title="Projects"
            className={`grid h-11 w-full place-items-center rounded-[14px] text-muted transition hover:bg-surface hover:text-foreground ${projectsOpen ? "bg-surface text-foreground shadow-sm" : ""}`}
          >
            <FolderSimple size={19} weight={projectsOpen ? "fill" : "regular"} />
            <span className="sr-only">Projects</span>
          </button>
        </nav>

        <div className="mt-auto grid place-items-center gap-3">
          <button
            type="button"
            onClick={(event) => {
              panelTrigger.current = event.currentTarget;
              setSettingsOpen((open) => !open);
              setProjectsOpen(false);
            }}
            aria-label="Settings"
            aria-expanded={settingsOpen}
            aria-controls="capso-settings-panel"
            title="Settings"
            className="grid h-11 w-11 place-items-center rounded-[13px] text-muted hover:bg-surface hover:text-foreground"
          >
            <GearSix size={19} />
          </button>
          <div className="grid h-8 w-8 place-items-center rounded-full bg-accent text-xs font-semibold uppercase text-accent-ink">
            {account.mode === "signed_in" ? account.email.slice(0, 2) : "LO"}
          </div>
        </div>
      </aside>

      <nav className="fixed inset-x-3 bottom-3 z-40 grid h-[68px] grid-cols-5 items-center rounded-2xl border border-line bg-background/95 px-2 shadow-2xl backdrop-blur md:hidden">
        {NAV_ITEMS.slice(0, 4).map(({ href, label, Icon }) => (
          <RailLink key={href} href={href} label={label} active={isActive(pathname, href)} onClick={closePanels} compact>
            <Icon size={21} weight={isActive(pathname, href) ? "fill" : "regular"} />
          </RailLink>
        ))}
        <button
          type="button"
          aria-label="More"
          aria-expanded={projectsOpen}
          aria-controls="capso-projects-panel"
          onClick={(event) => {
            panelTrigger.current = event.currentTarget;
            setProjectsOpen((open) => !open);
            setSettingsOpen(false);
          }}
          className={`grid min-h-12 place-items-center gap-0.5 rounded-xl text-muted ${projectsOpen ? "bg-surface text-foreground" : ""}`}
        >
          <DotsThree size={22} weight={projectsOpen ? "bold" : "regular"} />
          <span className="text-xs font-semibold">More</span>
        </button>
      </nav>

      {projectsOpen && (
        <Panel id="capso-projects-panel" title="Projects" mobileTitle="More" onClose={() => setProjectsOpen(false)} returnFocus={panelTrigger}>
          <nav aria-label="More destinations" className="mb-3 grid grid-cols-2 gap-1 border-b border-line pb-3">
            <Link href="/memory" onClick={() => setProjectsOpen(false)} className="flex min-h-11 items-center gap-2 rounded-xl px-3 text-xs font-medium hover:bg-background">
              <Brain size={18} /> Memory
            </Link>
            <Link href="/review" onClick={() => setProjectsOpen(false)} className="flex min-h-11 items-center gap-2 rounded-xl px-3 text-xs font-medium hover:bg-background">
              <Checks size={18} /> Review
            </Link>
            <button
              type="button"
              onClick={() => {
                document.getElementById("capso-import-input")?.click();
                setProjectsOpen(false);
              }}
              className="flex min-h-11 items-center gap-2 rounded-xl px-3 text-left text-xs font-medium hover:bg-background"
            >
              <Plus size={18} /> Add screenshots
            </button>
            <button
              type="button"
              onClick={() => {
                setProjectsOpen(false);
                setSettingsOpen(true);
              }}
              className="flex min-h-11 items-center gap-2 rounded-xl px-3 text-left text-xs font-medium hover:bg-background"
            >
              <GearSix size={18} /> Settings
            </button>
          </nav>
          <div className="grid gap-1">
            {threads.filter((thread) => !thread.archived).map((thread) => (
              <DropZone key={thread.id} armed={dragCount > 0} onDropIds={(ids) => void move(thread.id, ids)}>
                <Link href={`/threads/${thread.id}`} onClick={() => setProjectsOpen(false)} className="flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm hover:bg-background">
                  <span className="text-muted"><CapsoMark size={22} fill={fillFor(byThread(thread.id).length)} /></span>
                  <span className="min-w-0 flex-1 truncate">{thread.name}</span>
                  <span className="text-xs tabular-nums text-muted">{byThread(thread.id).length}</span>
                </Link>
              </DropZone>
            ))}
          </div>
          {adding ? (
            <input
              autoFocus
              placeholder="Project name…"
              onBlur={() => setAdding(false)}
              onKeyDown={async (event) => {
                if (event.key === "Enter" && event.currentTarget.value.trim()) {
                  await addThread(event.currentTarget.value.trim());
                  setAdding(false);
                }
                if (event.key === "Escape") setAdding(false);
              }}
              className="mt-3 min-h-11 w-full rounded-xl border border-line bg-background px-3 text-sm"
            />
          ) : (
            <button type="button" onClick={() => setAdding(true)} className="mt-3 min-h-11 w-full rounded-xl border border-dashed border-line px-3 text-left text-xs font-medium text-muted hover:text-foreground">+ New project</button>
          )}
        </Panel>
      )}

      {settingsOpen && (
        <Panel id="capso-settings-panel" title="Capso settings" onClose={() => setSettingsOpen(false)} returnFocus={panelTrigger}>
          <div className="grid gap-2 text-xs text-muted">
            <p className="flex items-center gap-2 rounded-xl bg-background px-3 py-2.5">
              <span className={`h-1.5 w-1.5 rounded-full ${ai?.configured ? "bg-accent" : "bg-muted"}`} />
              {ai?.configured ? "AI is ready" : "AI uses sample data"}
            </p>
            <div className="rounded-xl bg-background px-3 py-2.5">
              <p className="font-semibold text-foreground">{account.mode === "signed_in" ? account.email : "Local-only library"}</p>
              <p className="mt-0.5 text-xs leading-5">{account.mode === "signed_in" ? "Synced Capso account" : "Captures stay in this browser until you connect an account"}</p>
            </div>
            {account.mode === "signed_in" && <DevicesAndSync email={account.email} onNavigate={() => setSettingsOpen(false)} />}
            <button type="button" onClick={() => setKeys(true)} className="flex min-h-11 items-center rounded-xl px-3 text-left hover:bg-background hover:text-foreground">Keyboard shortcuts</button>
            {account.mode === "local" && <Link href="/extension" onClick={() => setSettingsOpen(false)} className="flex min-h-11 items-center rounded-xl px-3 hover:bg-background hover:text-foreground">Get the browser extension</Link>}
            {account.mode === "signed_in" && <ImportLocal />}
            {account.mode === "local" && account.openAccount && (
              <button type="button" onClick={account.openAccount} className="flex min-h-11 items-center rounded-xl px-3 text-left font-semibold text-accent hover:bg-background">
                Connect my Capso account
              </button>
            )}
            <button type="button" onClick={() => confirm("Delete the sample captures and keep only your own screenshots?") && void clearSamples()} className="flex min-h-11 items-center rounded-xl px-3 text-left hover:bg-background hover:text-foreground">Use only my screenshots</button>
            <button type="button" onClick={() => confirm("Reset demo data?") && void reset()} className="flex min-h-11 items-center rounded-xl px-3 text-left text-danger hover:bg-background">Reset demo data</button>
            {account.mode === "signed_in" && (
              <button
                type="button"
                onClick={() => {
                  if (!confirm(`Sign out of ${account.email} on this browser?`)) return;
                  void account.signOut().catch(() => toast("Capso could not sign out. Try again."));
                }}
                className="flex min-h-11 items-center rounded-xl px-3 text-left text-danger hover:bg-background"
              >
                Sign out
              </button>
            )}
          </div>
        </Panel>
      )}

      <div className="min-w-0 pb-28 md:ml-[78px] md:pb-24">
        {/* Search is suppressed during first run: doc 15 asks that nothing compete
            with the starter-kit screen. The rail and the capture layer stay — one
            is navigation the user can ignore, the other is the thing the screen is
            asking them to do. */}
        {pathname !== "/" && pathname !== "/search" && !showFirstRun && (
          <header className="sticky top-0 z-20 border-b border-line bg-background/95 px-5 backdrop-blur sm:px-8">
            <div className="mx-auto flex h-14 w-full max-w-[1440px] items-center">
            <button type="button" onClick={() => setPalette(true)} className="flex h-11 w-full max-w-sm items-center rounded-full border border-line bg-surface px-3.5 text-xs text-muted transition hover:border-accent hover:text-foreground">
              <MagnifyingGlass size={16} className="mr-2" /> Search memory
              <kbd className="ml-auto hidden rounded border border-line px-1.5 py-0.5 text-xs sm:block">⌘K</kbd>
            </button>
            </div>
          </header>
        )}
        <main className={pathname === "/" || pathname === "/search" ? "" : "mx-auto w-full max-w-[1440px] px-5 py-6 sm:px-8 lg:px-10"}>
          {showFirstRun ? <FirstRun /> : children}
        </main>
      </div>

      <CaptureLayer />
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
      <ShortcutSheet open={keys} onClose={() => setKeys(false)} />
    </div>
  );
}

function RailLink({ href, label, active, onClick, children, compact = false }: { href: string; label: string; active: boolean; onClick: () => void; children: React.ReactNode; compact?: boolean }) {
  return (
    <Link href={href} onClick={onClick} aria-label={label} title={compact ? undefined : label} className={`capso-rail-link grid place-items-center rounded-[14px] font-semibold ${compact ? "min-h-12 gap-0.5" : "h-11 w-full"} ${active ? "bg-surface text-foreground shadow-sm" : "text-muted hover:bg-surface hover:text-foreground"}`}>
      {children}
      <span className={compact ? "text-xs" : "sr-only"}>{label}</span>
    </Link>
  );
}

function Panel({
  id,
  title,
  mobileTitle,
  onClose,
  returnFocus,
  children,
}: {
  id: string;
  title: string;
  mobileTitle?: string;
  onClose: () => void;
  returnFocus: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    close.current?.focus();
    const trigger = returnFocus.current;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panel.current) return;
      const focusable = Array.from(
        panel.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      trigger?.focus();
    };
  }, [returnFocus]);

  return (
    <>
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-foreground/10 md:hidden"
      />
      <aside
      ref={panel}
      id={id}
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${id}-title`}
      className="capso-panel fixed bottom-[88px] left-3 z-50 max-h-[70vh] w-[min(340px,calc(100vw-24px))] overflow-y-auto rounded-[22px] border border-line bg-surface p-4 shadow-2xl md:bottom-auto md:left-[90px] md:top-4 md:max-h-[calc(100vh-32px)]"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id={`${id}-title`} className="text-sm font-semibold">
          <span className={mobileTitle ? "hidden md:inline" : ""}>{title}</span>
          {mobileTitle && <span className="md:hidden">{mobileTitle}</span>}
        </h2>
        <button ref={close} type="button" onClick={onClose} aria-label="Close panel" className="grid h-12 w-12 place-items-center rounded-full bg-background text-muted"><X size={16} /></button>
      </div>
      {children}
      </aside>
    </>
  );
}

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}
