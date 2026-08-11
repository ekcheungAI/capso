"use client";

import Link from "next/link";
import { Art } from "@/components/art";
import { useStore } from "@/lib/store/provider";

/**
 * The front door, and the fix for the bug that prompted this work.
 *
 * `app/page.tsx` gated its welcome on `screenshots.length === 0 && threads.length
 * === 0`. Picking a role creates projects, so that test went false immediately
 * and almost every new user landed on "Today's tray" — a heading, an empty tray
 * and a row of empty projects — instead of anything welcoming. The welcome it
 * did have passed `action` a plain string, so the most important moment in the
 * product had no button.
 *
 * Not an `EmptyState` variant. `EmptyState` has nine call sites and eight of them
 * mean "this list is currently empty" — small, transient, in-flow. This one is a
 * page: it wants art at scale, no dashed border (which reads as a drop target and
 * fights the illustration), a real primary control, and the keyboard hints. A
 * prop that is right in one call site out of nine is a trap for whoever adds the
 * tenth.
 */
export function FirstCapture({ variant }: { variant: "page" | "nudge" }) {
  const { threads } = useStore();
  const projects = threads.filter((t) => !t.archived).slice(0, 5);

  // Same handle app/page.tsx and shell.tsx use — the file input lives in
  // CaptureLayer, which is now mounted during first run too.
  const openImport = () => document.getElementById("capso-import-input")?.click();

  if (variant === "nudge") {
    return (
      <div className="mb-6 flex items-center gap-4 rounded-xl border border-line bg-surface p-3">
        <Art
          name="role-empty"
          sizes="72px"
          className="hidden h-14 w-20 shrink-0 rounded-lg object-cover sm:block"
        />
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted">
          These are samples, so you can see how filing works. Add one of your own whenever you like.
        </p>
        <button
          type="button"
          onClick={openImport}
          className="min-h-11 shrink-0 rounded-full bg-accent px-4 text-xs font-medium text-accent-ink"
        >
          Add a screenshot
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1740px] px-5 py-7 sm:px-8 lg:px-12">
      <div className="mx-auto max-w-xl py-6 text-center sm:py-12">
        <Art
          name="role-empty"
          priority
          sizes="(min-width: 640px) 420px, 100vw"
          className="mx-auto mb-8 w-full max-w-[420px] rounded-xl"
        />

        <h1 className="text-2xl font-semibold tracking-[-0.03em] sm:text-3xl">
          Your visual memory starts with one screenshot
        </h1>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted">
          Drop an image anywhere, paste from the clipboard, or press Capture. Capso will organise the rest.
        </p>

        <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={openImport}
            className="min-h-11 rounded-full bg-accent px-5 text-sm font-medium text-accent-ink"
          >
            Add screenshots
          </button>
          <Link
            href="/extension"
            className="min-h-11 rounded-full border border-line bg-surface px-5 text-sm leading-[2.6] text-muted hover:text-foreground"
          >
            Capture from your browser
          </Link>
        </div>

        {/* Both of these are live now that CaptureLayer mounts during first run.
            Before this change they were instructions the app could not honour. */}
        <p className="mt-5 text-xs text-muted">
          or press{" "}
          <kbd className="rounded border border-line px-1.5 py-0.5">⌘V</kbd> to paste, or drop an image
          anywhere on this page
        </p>

        {projects.length > 0 && (
          <div className="mt-9 border-t border-line pt-6">
            <p className="text-xs text-muted">Waiting for it:</p>
            <div className="mt-2.5 flex flex-wrap justify-center gap-1.5">
              {projects.map((p) => (
                <span key={p.id} className="rounded-full border border-line px-2.5 py-1 text-xs text-muted">
                  {p.name}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
