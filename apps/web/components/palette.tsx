"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useStore } from "@/lib/store/provider";
import { INTENT_LABEL } from "@/components/ui";
import { retrieve } from "@/lib/retrieve";

/**
 * ⌘K palette. Pattern from Bonsai/Gusto: recents when empty, type badge on the
 * right, the containing project as a breadcrumb under each row, and a footer
 * that teaches the shortcuts. This is the fastest path from "I remember
 * something" to the capture, which is the whole product promise.
 *
 * Ranking is `retrieve()`, the same function /search and the thread chat use.
 * This panel used to carry its own AND-of-substrings filter over six fields,
 * which meant the most-used search surface in the product was also the only one
 * with no CJK segmentation, no ranking, and no reach into `userTags` or
 * `pageTitle` — a 繁體中文 query that worked on /search returned nothing here.
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const { screenshots, threads, threadName, visit, revisits } = useStore();
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  // The input stays responsive on every keystroke; only the full-library scan
  // below is debounced — it used to re-run synchronously on every letter typed.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 150);
    return () => clearTimeout(t);
  }, [q]);

  const results = useMemo(() => {
    if (!debouncedQ.trim()) {
      return screenshots
        .filter((s) => !s.archived)
        .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
        .slice(0, 6);
    }
    return retrieve(debouncedQ, screenshots, threads, 8, revisits).map((r) => r.s);
  }, [debouncedQ, screenshots, threads, revisits]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCursor((c) => Math.min(c + 1, results.length - 1));
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => Math.max(c - 1, 0));
      }
      if (e.key === "Enter") {
        const hit = results[cursor];
        if (hit) {
          void visit(hit.id, "search_clicked");
          router.push(`/s/${hit.id}`);
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, results, cursor, router, onClose, visit]);

  useEffect(() => {
    listRef.current?.children[cursor]?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (!open) return null;

  return (
    <div
      className="capso-fade fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[12vh] backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="capso-pop w-full max-w-xl overflow-hidden rounded-xl bg-surface shadow-2xl ring-1 ring-line"
      >
        <input
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setCursor(0);
          }}
          placeholder="Search your memory…"
          className="w-full border-b border-line bg-transparent px-4 py-3.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        />

        {!q && <p className="px-4 pt-3 text-xs uppercase tracking-wide text-muted">Recent</p>}

        <ul ref={listRef} className="max-h-80 overflow-y-auto py-2">
          {results.length === 0 && (
            <li className="px-4 py-6 text-center text-xs text-muted">
              Nothing matches. Try a phrase you&apos;d remember seeing in the screenshot.
            </li>
          )}
          {results.map((s, i) => (
            <li key={s.id}>
              <button
                onMouseEnter={() => setCursor(i)}
                onClick={() => {
                  void visit(s.id, "search_clicked");
                  router.push(`/s/${s.id}`);
                  onClose();
                }}
                className={`flex w-full items-center gap-3 px-4 py-2 text-left ${
                  i === cursor ? "bg-background" : ""
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{s.title}</span>
                  <span className="block truncate text-xs text-muted">
                    {threadName(s.threadId)} · {s.summary}
                  </span>
                </span>
                <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-xs text-muted">
                  {INTENT_LABEL[s.intent]}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-4 border-t border-line px-4 py-2 text-xs text-muted">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span className="ml-auto">esc close</span>
        </div>
      </div>
    </div>
  );
}
