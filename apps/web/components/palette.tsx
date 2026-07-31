"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useStore } from "@/lib/store/provider";
import { INTENT_LABEL } from "@/components/ui";

/**
 * ⌘K palette. Pattern from Bonsai/Gusto: recents when empty, type badge on the
 * right, the containing project as a breadcrumb under each row, and a footer
 * that teaches the shortcuts. This is the fastest path from "I remember
 * something" to the capture, which is the whole product promise.
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const { screenshots, threadName, visit } = useStore();
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const results = useMemo(() => {
    const live = screenshots.filter((s) => !s.archived);
    if (!q.trim()) {
      return [...live].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)).slice(0, 6);
    }
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return live
      .filter((s) => {
        const hay = `${s.title} ${s.summary} ${s.ocrText} ${s.whySaved} ${INTENT_LABEL[s.intent]} ${threadName(s.threadId)}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .slice(0, 8);
  }, [q, screenshots, threadName]);

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
          className="w-full border-b border-line bg-transparent px-4 py-3.5 text-sm outline-none"
        />

        {!q && <p className="px-4 pt-3 text-[11px] uppercase tracking-wide text-muted">Recent</p>}

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
                  <span className="block truncate text-[13px]">{s.title}</span>
                  <span className="block truncate text-[11px] text-muted">
                    {threadName(s.threadId)} · {s.summary}
                  </span>
                </span>
                <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[10px] text-muted">
                  {INTENT_LABEL[s.intent]}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-4 border-t border-line px-4 py-2 text-[11px] text-muted">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span className="ml-auto">esc close</span>
        </div>
      </div>
    </div>
  );
}
