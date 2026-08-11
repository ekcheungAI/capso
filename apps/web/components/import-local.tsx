"use client";

import { useEffect, useState } from "react";
import { backend } from "@/lib/store/backend";
import { importLocalLibrary, localLibrarySize, type ImportProgress } from "@/lib/store/import-local";
import { useToast } from "@/components/toast";
import { plural } from "@/lib/plural";

/**
 * Offer to move a library captured in this browser up to the account.
 *
 * Renders nothing at all unless there is a real decision to make: the app has to
 * be talking to Supabase *and* this browser has to be holding captures that are
 * not there. Locally-backed installs — which is every install until anonymous
 * sign-ins are switched on — never see it, and neither does a fresh browser.
 *
 * It is deliberately not automatic. Uploading someone's whole library the first
 * time they open a signed-in tab is a large, slow, surprising thing to do on
 * their behalf, and the import is safe to run late but impossible to undo
 * quietly.
 */
export function ImportLocal() {
  const [count, setCount] = useState(0);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const toast = useToast();

  useEffect(() => {
    let stop = false;
    void (async () => {
      const b = await backend();
      // Nothing to import *into* — the local library is already the live one.
      if (b.kind !== "remote") return;
      const n = await localLibrarySize();
      if (!stop) setCount(n);
    })();
    return () => {
      stop = true;
    };
  }, []);

  if (count === 0) return null;

  const running = progress !== null;

  return (
    <button
      disabled={running}
      onClick={async () => {
        if (!confirm(`Copy ${plural(count, "capture")} from this browser into your account?`)) return;
        setProgress({ done: 0, total: count });
        try {
          const b = await backend();
          const { captures, failed } = await importLocalLibrary(b, setProgress);
          toast(
            failed.length === 0
              ? `Copied ${plural(captures, "capture")} into your account.`
              : `Copied ${captures}. ${plural(failed.length, "capture")} could not be read.`,
          );
          // A one-time migration that has just rewritten every id: re-reading the
          // whole library is both the simplest way to show the result and the
          // only one that cannot leave stale ids in React state.
          setTimeout(() => location.reload(), 1200);
        } catch {
          setProgress(null);
          toast("Import failed - nothing was lost; your captures are still in this browser.");
        }
      }}
      className="text-left hover:text-accent disabled:opacity-60"
    >
      {running
        ? `Copying ${progress.done}/${progress.total}…`
        : `Copy ${plural(count, "capture")} to your account`}
    </button>
  );
}
