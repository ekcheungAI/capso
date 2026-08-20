"use client";

import { useState } from "react";
import { Art, type ArtName } from "@/components/art";
import { useStore } from "@/lib/store/provider";
import { ROLES } from "@/lib/templates";

/**
 * Generated art per role (D17). The four frames were reviewed together at real
 * card width and re-rolled as a set, not individually — a card that reads as a
 * different shoot breaks the group even when it is a good photograph on its own.
 */
const ROLE_ART: Record<string, ArtName> = {
  marketing: "role-marketing",
  product: "role-product",
  founder: "role-founder",
  empty: "role-empty",
};

/**
 * One screen, one decision. Picking a role only creates projects — it sets no
 * mode and is never asked again, so the cost of choosing wrong is a rename.
 * The starter projects are listed on each card because a promise you can read
 * beats a promise you have to accept blind.
 */
export function FirstRun() {
  const { applyTemplate, loadSamples, skipSetup } = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const finishSetup = async (id: string, setup: () => Promise<void>) => {
    if (busy) return;
    setBusy(id);
    setError(null);
    try {
      await setup();

      // The picker is taller than the page it reveals. Choosing an action near
      // the bottom used to preserve that old scroll offset, so `/library` opened
      // halfway through its masonry with the title, status and filters above the
      // viewport. A new information architecture must always start at its top.
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    } catch {
      setError("Couldn’t finish setup. Try that choice again.");
    } finally {
      setBusy(null);
    }
  };

  const pick = (id: string) => finishSetup(id, () => applyTemplate(id));

  return (
    <div className="mx-auto max-w-3xl py-10">
      <h1 className="text-[28px] font-semibold leading-tight tracking-tight">What kind of work do you screenshot for?</h1>
      <p className="mt-1.5 text-xs text-muted">
        This sets up your projects so captures have somewhere to land. Rename or delete any of them later.
      </p>
      {busy && <p className="sr-only" role="status" aria-live="polite">Setting up your library.</p>}
      {error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}

      <div className="mt-7 grid gap-3 sm:grid-cols-2">
        {ROLES.map((role) => (
          <button
            key={role.id}
            disabled={busy !== null}
            onClick={() => void pick(role.id)}
            className="group min-h-11 overflow-hidden rounded-xl bg-surface text-left ring-1 ring-line transition-[box-shadow,transform] duration-[120ms] ease-out hover:-translate-y-0.5 hover:ring-accent disabled:opacity-50"
          >
            {ROLE_ART[role.id] && (
              // aspect-[2/1], not a fixed short strip. The first cut used h-28,
              // which crops a 3:2 frame to about 3.4:1 — and because the art is
              // composed with deliberate negative space, that centre crop landed
              // on empty paper and the cards looked blank. The subject sits
              // roughly centred in all four, so 2:1 keeps it.
              <Art
                name={ROLE_ART[role.id]}
                sizes="(min-width: 640px) 380px, 100vw"
                priority={role.id === "marketing"}
                className="aspect-[2/1] w-full object-cover"
              />
            )}
            <div className="p-4">
            <p className="text-sm font-medium">{role.name}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted">{role.blurb}</p>

            {role.projects.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {role.projects.map((p) => (
                  <span
                    key={p.name}
                    title={p.description}
                    className="rounded-full border border-line px-2 py-0.5 text-xs text-muted"
                  >
                    {p.name}
                  </span>
                ))}
              </div>
            )}

            <p className="mt-3 text-xs text-accent opacity-0 transition-opacity group-hover:opacity-100">
              {busy === role.id ? "Setting up…" : "Use this →"}
            </p>
            </div>
          </button>
        ))}
      </div>

      <p className="mt-6 text-xs text-muted">
        Just looking?{" "}
        <button
          disabled={busy !== null}
          onClick={() => {
            void finishSetup("samples", loadSamples);
          }}
          className="min-h-11 text-accent underline underline-offset-2 disabled:opacity-50"
        >
          Explore with sample captures
        </button>
        {" · "}
        {/* An explicit way out. The picker now renders inside the shell, so the
            rail can navigate away from it — but leaving without answering left
            `needsSetup` true and the cover reappeared on the next route, which
            reads as the app refusing to let go. */}
        <button
          disabled={busy !== null}
          onClick={() => {
            void finishSetup("skip", skipSetup);
          }}
          className="min-h-11 text-accent underline underline-offset-2 disabled:opacity-50"
        >
          Skip for now
        </button>
      </p>

      {/* Drop, paste and Capture are all live on this screen now. They were not
          before: Shell returned early here and never mounted CaptureLayer. */}
      <p className="mt-3 text-xs text-muted">
        Already have one? Drop it anywhere on this page and pick a project after.
      </p>
    </div>
  );
}
