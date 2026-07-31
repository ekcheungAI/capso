"use client";

import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useStore } from "@/lib/store/provider";
import type { Intent } from "@/lib/store";
import { imageFor, INTENT_LABEL, INTENTS } from "@/components/ui";

/**
 * Screenshot detail — the "what does this actually tell me" surface.
 * Elements are the list in 13_WEB_APP_PLAN.md; opening it writes a revisit (F5).
 */
export default function DetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { ready, get, threads, threadName, assign, saveWhySaved, saveIntent, remove, visit } =
    useStore();
  const s = get(id);

  const [zoom, setZoom] = useState(false);
  const [ocrOpen, setOcrOpen] = useState(true);
  const [draft, setDraft] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const visited = useRef(false);

  useEffect(() => {
    if (s && !visited.current) {
      visited.current = true;
      void visit(s.id, "opened_detail");
    }
  }, [s, visit]);

  if (!ready) return <p className="text-xs text-muted">Loading…</p>;
  if (!s)
    return (
      <div className="text-sm">
        <p>That capture is gone.</p>
        <Link href="/" className="mt-2 inline-block text-xs text-accent">
          Back to library
        </Link>
      </div>
    );

  const flash = (what: string) => {
    setCopied(what);
    setTimeout(() => setCopied(null), 1200);
  };

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      <div className="min-w-0 flex-1">
        <button
          onClick={() => setZoom((z) => !z)}
          className="block w-full cursor-zoom-in"
          aria-label={zoom ? "Zoom out" : "Zoom in"}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- data URI */}
          <img
            src={imageFor(s)}
            alt={s.title}
            className={`rounded-xl border border-line bg-surface ${
              zoom ? "w-auto max-w-none" : "w-full"
            }`}
          />
        </button>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <button
            onClick={() => {
              void navigator.clipboard.writeText(imageFor(s));
              void visit(s.id, "copied");
              flash("image");
            }}
            className="rounded-md border border-line px-3 py-1.5"
          >
            Copy image
          </button>
          <a
            href={imageFor(s)}
            download={`${s.title}.png`}
            className="rounded-md border border-line px-3 py-1.5"
          >
            Download
          </a>
          <button
            onClick={async () => {
              if (!confirm("Deletes the image, OCR text and every reference to it. Cannot be undone.")) return;
              await remove(s);
              router.push("/");
            }}
            className="rounded-md px-3 py-1.5 text-muted hover:text-accent"
          >
            Delete
          </button>
          {copied && <span className="text-muted">Copied {copied}</span>}
        </div>
      </div>

      <aside className="w-full shrink-0 space-y-5 lg:w-80">
        <div>
          <h1 className="text-sm font-semibold">{s.title}</h1>
          <p className="mt-1 text-xs text-muted">
            {new Date(s.capturedAt).toLocaleString("en-GB")} · {s.source.replace(/_/g, " ")} ·{" "}
            {s.type.replace(/_/g, " ")}
          </p>
        </div>

        <Field label="Summary">
          <p className="text-xs leading-relaxed">{s.summary}</p>
        </Field>

        {/* Editable — owner decision; every edit is a training signal. */}
        <Field label="Why I saved this">
          {draft === null ? (
            <button
              onClick={() => setDraft(s.whySaved)}
              className="w-full text-left text-xs leading-relaxed hover:text-accent"
            >
              {s.whySaved || <span className="text-muted">Add a reason…</span>}
            </button>
          ) : (
            <div className="space-y-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={3}
                className="w-full rounded-md border border-line bg-surface p-2 text-xs"
              />
              <div className="flex gap-2">
                <button
                  onClick={async () => {
                    await saveWhySaved(s, draft.trim());
                    setDraft(null);
                  }}
                  className="rounded-md bg-accent px-3 py-1 text-xs text-white"
                >
                  Save
                </button>
                <button onClick={() => setDraft(null)} className="text-xs text-muted">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </Field>

        <Field label="Intent">
          <select
            value={s.intent}
            onChange={(e) => void saveIntent(s, e.target.value as Intent)}
            className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-xs"
          >
            {INTENTS.map((i) => (
              <option key={i} value={i}>
                {INTENT_LABEL[i]}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Project">
          <select
            value={s.threadId ?? ""}
            onChange={(e) => void assign(s, e.target.value || null, "manual")}
            className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-xs"
          >
            <option value="">Inbox</option>
            {threads.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {s.suggestedThreadId && s.suggestedThreadId !== s.threadId && (
            <p className="mt-1 text-[11px] text-muted">
              Capso suggested {threadName(s.suggestedThreadId)} ({Math.round(s.confidence * 100)}%)
            </p>
          )}
        </Field>

        <Field label={`OCR text (${s.ocrText.length} chars)`}>
          <button onClick={() => setOcrOpen((o) => !o)} className="text-[11px] text-accent">
            {ocrOpen ? "Collapse" : "Expand"}
          </button>
          {ocrOpen && (
            <>
              <pre className="mt-2 max-h-56 overflow-auto rounded-md border border-line bg-surface p-2 text-[11px] leading-relaxed whitespace-pre-wrap">
                {s.ocrText || "No text found."}
              </pre>
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(s.ocrText);
                  flash("text");
                }}
                className="mt-1.5 text-[11px] text-accent"
              >
                Copy text
              </button>
            </>
          )}
        </Field>
      </aside>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] uppercase tracking-wide text-muted">{label}</p>
      {children}
    </div>
  );
}
