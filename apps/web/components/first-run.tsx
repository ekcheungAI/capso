"use client";

import { useState } from "react";
import { useStore } from "@/lib/store/provider";
import { ROLES } from "@/lib/templates";

/**
 * One screen, one decision. Picking a role only creates projects — it sets no
 * mode and is never asked again, so the cost of choosing wrong is a rename.
 * The starter projects are listed on each card because a promise you can read
 * beats a promise you have to accept blind.
 */
export function FirstRun() {
  const { applyTemplate, loadSamples } = useStore();
  const [busy, setBusy] = useState<string | null>(null);

  const pick = async (id: string) => {
    if (busy) return;
    setBusy(id);
    await applyTemplate(id);
  };

  return (
    <div className="mx-auto max-w-3xl py-10">
      <h1 className="text-[28px] font-semibold leading-tight tracking-tight">What kind of work do you screenshot for?</h1>
      <p className="mt-1.5 text-xs text-muted">
        This sets up your projects so captures have somewhere to land. Rename or delete any of them later.
      </p>

      <div className="mt-7 grid gap-3 sm:grid-cols-2">
        {ROLES.map((role) => (
          <button
            key={role.id}
            disabled={busy !== null}
            onClick={() => void pick(role.id)}
            className="group rounded-xl bg-surface p-4 text-left ring-1 ring-line transition-[box-shadow,transform] duration-[120ms] ease-out hover:-translate-y-0.5 hover:ring-accent disabled:opacity-50"
          >
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
          </button>
        ))}
      </div>

      <p className="mt-6 text-xs text-muted">
        Just looking?{" "}
        <button
          disabled={busy !== null}
          onClick={() => {
            setBusy("samples");
            void loadSamples();
          }}
          className="text-accent underline underline-offset-2 disabled:opacity-50"
        >
          Explore with sample captures
        </button>
      </p>
    </div>
  );
}
