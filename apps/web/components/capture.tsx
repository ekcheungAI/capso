"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useStore } from "@/lib/store/provider";
import { classify, fewShotLines } from "@/lib/classify";
import { newId, routeConfidence, type Screenshot } from "@/lib/store";

/**
 * Capture layer: drop or paste an image anywhere, or press the Capture button.
 * Each ingest spawns the post-capture overlay described in 05_FEATURE_SPEC_CAPTURE.md
 * — the product's signature moment, so it lives in one component that the Mac
 * app's Tauri window will later render identically.
 */
export function CaptureLayer() {
  const { ready, threads, screenshots, corrections, ingest, get } = useStore();
  const [pending, setPending] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);

  const start = useCallback(
    async (dataUrl: string, source: Screenshot["source"]) => {
      const id = newId();
      const now = new Date().toISOString();

      // Saved first, classified second — capture is never blocked by the model.
      await ingest({
        id,
        title: "New capture",
        summary: "",
        whySaved: "",
        ocrText: "",
        intent: "other",
        type: "other",
        threadId: null,
        suggestedThreadId: null,
        confidence: 0,
        status: "processing",
        assignmentSource: null,
        source,
        capturedAt: now,
        imageDataUrl: dataUrl,
        hue: 210,
        aspect: "wide",
        archived: false,
      });
      setPending((p) => [id, ...p]);

      const result = await classify(
        dataUrl,
        threads,
        fewShotLines(corrections, screenshots, threads),
      );
      const band = routeConfidence(result.confidence);

      await ingest({
        id,
        title: result.title,
        summary: result.summary,
        whySaved: result.whySaved,
        ocrText: result.ocrText,
        intent: result.intent,
        type: result.type,
        threadId: band === "auto" ? result.projectSuggestion : null,
        suggestedThreadId: result.projectSuggestion,
        confidence: result.confidence,
        status: "done",
        assignmentSource: band === "auto" ? "auto" : null,
        source,
        capturedAt: now,
        imageDataUrl: dataUrl,
        hue: 210,
        aspect: "wide",
        archived: false,
      });
    },
    [ingest, threads, screenshots, corrections],
  );

  const readFile = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = () => void start(String(reader.result), "drag");
      reader.readAsDataURL(file);
    },
    [start],
  );

  useEffect(() => {
    const onDrop = (e: DragEvent) => {
      const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith("image/"));
      if (!file) return;
      e.preventDefault();
      setDragging(false);
      readFile(file);
    };
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
        setDragging(true);
      }
    };
    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragging(false);
    };
    const onPaste = (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
      const file = item?.getAsFile();
      if (file) readFile(file);
    };

    window.addEventListener("drop", onDrop);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("paste", onPaste);
    };
  }, [readFile]);

  if (!ready) return null;

  return (
    <>
      <button
        onClick={() => void start(sampleCapture(), "hotkey_region")}
        title="Stands in for ⌃⇧C until the Mac app is wired up"
        className="fixed right-6 bottom-6 z-30 rounded-full bg-accent px-4 py-2.5 text-xs font-medium text-white shadow-lg"
      >
        Capture
      </button>

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-background/70 backdrop-blur-sm">
          <p className="rounded-xl border-2 border-dashed border-accent px-8 py-6 text-sm">
            Drop to capture
          </p>
        </div>
      )}

      <div className="fixed right-6 bottom-20 z-40 flex flex-col-reverse gap-3">
        {pending.map((id) => {
          const s = get(id);
          return s ? (
            <Overlay
              key={id}
              s={s}
              onClose={() => setPending((p) => p.filter((x) => x !== id))}
            />
          ) : null;
        })}
      </div>
    </>
  );
}

/** The four chip states from 05: loading → suggestion → confirmed → timeout. */
function Overlay({ s, onClose }: { s: Screenshot; onClose: () => void }) {
  const { threads, threadName, assign, remove } = useStore();
  const router = useRouter();
  const [adjusting, setAdjusting] = useState(false);
  const hovering = useRef(false);

  const state =
    s.status === "processing"
      ? "loading"
      : s.threadId
        ? "confirmed"
        : s.suggestedThreadId
          ? "suggestion"
          : "timeout";

  // Auto-dismiss after 8s idle. Dismissal never loses data — the capture is saved.
  useEffect(() => {
    if (state === "loading" || adjusting) return;
    const t = setTimeout(() => {
      if (!hovering.current) onClose();
    }, 8000);
    return () => clearTimeout(t);
  }, [state, adjusting, onClose]);

  return (
    <div
      onMouseEnter={() => (hovering.current = true)}
      onMouseLeave={() => (hovering.current = false)}
      className="w-64 overflow-hidden rounded-xl bg-surface shadow-xl ring-1 ring-line"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- data URI */}
      <img src={s.imageDataUrl ?? ""} alt="" className="h-28 w-full object-cover object-top" />

      <div className="space-y-2 p-3">
        {state === "loading" && (
          <p className="animate-pulse text-[11px] text-muted">Analysing…</p>
        )}

        {state === "suggestion" && (
          <>
            <p className="text-[11px]">
              <span className="text-muted">Project:</span> {threadName(s.suggestedThreadId)}{" "}
              <span className="text-muted">· {Math.round(s.confidence * 100)}%</span>
            </p>
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => void assign(s, s.suggestedThreadId, "auto")}
                className="rounded-md bg-accent px-2.5 py-1 text-[11px] text-white"
              >
                ✓ Confirm
              </button>
              <button
                onClick={() => setAdjusting((a) => !a)}
                className="rounded-md border border-line px-2.5 py-1 text-[11px]"
              >
                Change
              </button>
              <button onClick={onClose} className="px-2 py-1 text-[11px] text-muted">
                Ignore
              </button>
            </div>
          </>
        )}

        {state === "confirmed" && (
          <p className="text-[11px]">
            Saved to <span className="font-medium">{threadName(s.threadId)}</span>{" "}
            <button onClick={() => setAdjusting(true)} className="text-accent">
              edit
            </button>
          </p>
        )}

        {state === "timeout" && (
          <p className="text-[11px] text-muted">Saved to Inbox — not sure where it belongs.</p>
        )}

        {adjusting && (
          <select
            autoFocus
            defaultValue={s.threadId ?? ""}
            onChange={(e) => {
              void assign(s, e.target.value || null, "user_corrected");
              setAdjusting(false);
            }}
            className="w-full rounded-md border border-line bg-background px-2 py-1 text-[11px]"
          >
            <option value="">Inbox</option>
            {threads.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        )}

        {state !== "loading" && (
          <div className="flex items-center gap-2 border-t border-line pt-2 text-[11px] text-muted">
            <button
              onClick={() => router.push(`/threads/${s.threadId ?? s.suggestedThreadId ?? "inbox"}`)}
              className="hover:text-accent"
            >
              Ask AI
            </button>
            <button onClick={() => router.push(`/s/${s.id}`)} className="hover:text-accent">
              Open
            </button>
            <button
              onClick={async () => {
                await remove(s);
                onClose();
              }}
              className="hover:text-accent"
            >
              Delete
            </button>
            <button onClick={onClose} className="ml-auto hover:text-accent">
              ✕
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** A tiny fake "screen" so the Capture button works with nothing to drag. */
function sampleCapture() {
  const hue = Math.floor(Math.random() * 360);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400">
    <rect width="640" height="400" fill="hsl(${hue} 30% 95%)"/>
    <rect width="640" height="52" fill="hsl(${hue} 36% 88%)"/>
    <rect x="40" y="110" width="380" height="22" rx="11" fill="hsl(${hue} 24% 64%)"/>
    <rect x="40" y="150" width="300" height="14" rx="7" fill="hsl(${hue} 20% 72%)"/>
    <rect x="40" y="200" width="220" height="14" rx="7" fill="hsl(${hue} 20% 72%)"/>
    <rect x="440" y="300" width="150" height="44" rx="22" fill="hsl(${hue} 55% 58%)"/>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
