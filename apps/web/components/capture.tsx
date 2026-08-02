"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useStore } from "@/lib/store/provider";
import { useToast } from "@/components/toast";
import { classify, fewShotLines } from "@/lib/classify";
import { tagVocabulary } from "@/lib/tags";
import { newId, routeConfidence, type Screenshot } from "@/lib/store";
import { CapsoMark } from "@/components/mark.generated";
import { deviceToken } from "@/lib/device";

/**
 * Capture layer: drop or paste an image anywhere, or press the Capture button.
 * Each ingest spawns the post-capture overlay described in 05_FEATURE_SPEC_CAPTURE.md
 * — the product's signature moment, so it lives in one component that the Mac
 * app's Tauri window will later render identically.
 */
export function CaptureLayer() {
  const { ready, threads, screenshots, corrections, ingest, patch, get } = useStore();
  const toast = useToast();
  const router = useRouter();
  const [pending, setPending] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState<{ done: number; total: number } | null>(null);
  /**
   * Capture ids this tab has already stored. The extension re-sends until it is
   * confirmed, so without this a lost ack would produce a second capsule of the
   * same screenshot.
   */
  const seen = useRef<Set<string>>(new Set());

  const start = useCallback(
    async (
      /**
       * Always a processed image, never a raw data URL. Taking `Downscaled`
       * rather than a string is what stops a capture path from skipping the
       * pipeline — the extension used to hand its raw retina PNG straight in
       * here, at 3–11 MB a row.
       */
      image: Downscaled,
      source: Screenshot["source"],
      opts: {
        overlay?: boolean;
        /** Page context, when the capture came from a browser tab. */
        pageUrl?: string | null;
        pageTitle?: string | null;
        /** Host or app the capture came from — the provenance badge's data. */
        sourceApp?: string | null;
      } = {},
    ) => {
      const id = newId();
      const now = new Date().toISOString();
      const { dataUrl, thumbDataUrl, aspect, width, height } = image;

      /**
       * Fields that describe where the capture came from rather than what the
       * model made of it. They are written on the first pass and carried through
       * the second unchanged, so a classification failure never loses them.
       */
      const context = {
        pageUrl: opts.pageUrl ?? null,
        pageTitle: opts.pageTitle ?? null,
        sourceApp: opts.sourceApp ?? null,
        userTags: [],
        contentHash: null,
        originalPath: null,
        thumbPath: null,
        thumbDataUrl,
        width,
        height,
      };

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
        aspect,
        archived: false,
        simulated: false,
        tags: [],
        ocrSource: null,
        ocrLangs: [],
        ...context,
      });
      if (opts.overlay !== false) setPending((p) => [id, ...p]);

      const result = await classify(
        dataUrl,
        threads,
        fewShotLines(corrections, screenshots, threads),
        { pageUrl: context.pageUrl, pageTitle: context.pageTitle },
        tagVocabulary(screenshots),
      );
      const band = routeConfidence(result.confidence);

      /**
       * Filed only when the band says so AND a project was actually resolved.
       * Derived once, because computing `threadId` and `assignmentSource` from
       * two separate expressions let them disagree: a high-confidence result
       * whose project name failed to match wrote `assignmentSource: "auto"`
       * with `threadId: null` — a row claiming to be auto-filed while sitting
       * unfiled, which no surface could explain.
       */
      const filedTo = band === "auto" ? result.projectSuggestion : null;

      /**
       * A patch of model-owned fields, not a whole-object write.
       *
       * The previous version rebuilt the entire row from the pre-classify
       * snapshot — hardcoding `userTags: []` and `archived: false` — so
       * anything the user did during the up-to-60s classification window was
       * silently destroyed: filing it, tagging it, archiving it, editing why
       * they saved it. That is exactly the window in which the overlay invites
       * them to press Confirm.
       *
       * `threadId` is only asserted when the model actually earned it; a
       * user-filed capture keeps the destination they chose.
       */
      await patch(id, (current) => ({
        title: result.title,
        summary: result.summary,
        ocrText: result.ocrText,
        type: result.type,
        suggestedThreadId: result.projectSuggestion,
        confidence: result.confidence,
        status: result.status,
        simulated: result.simulated,
        tags: result.tags,
        ocrSource: result.ocrSource,
        ocrLangs: result.ocrLangs,
        // `why_saved` and `intent` are the model's guesses but the user's to
        // correct, and correcting either writes to the learning ledger. If they
        // got there first while the model was still running, their answer wins.
        ...(current.whySaved ? {} : { whySaved: result.whySaved }),
        ...(current.intent === "other" ? { intent: result.intent } : {}),
        ...(filedTo ? { threadId: filedTo, assignmentSource: "auto" as const } : {}),
      }));
    },
    [ingest, patch, threads, screenshots, corrections],
  );

  /**
   * One or many files, same path. A single file keeps the signature overlay; a
   * bulk import (a folder of real screenshots) reports progress instead, since
   * fifty overlays would bury the app. Classification stays sequential — the
   * model call is the slow part and firing fifty at once helps nobody.
   */
  const ingestFiles = useCallback(
    async (files: File[], source: Screenshot["source"]) => {
      const images = files.filter((f) => f.type.startsWith("image/"));
      if (images.length === 0) return;

      const overlay = images.length === 1;
      let failed = 0;
      if (!overlay) setImporting({ done: 0, total: images.length });

      for (const [i, file] of images.entries()) {
        try {
          await start(await downscale(file), source, { overlay });
        } catch {
          failed++; // an unreadable file must not abort the rest of the import
        }
        if (!overlay) setImporting({ done: i + 1, total: images.length });
      }

      setImporting(null);
      if (!overlay) {
        const landed = images.length - failed;
        toast(
          failed
            ? `Imported ${landed} of ${images.length} — ${failed} could not be read`
            : `Imported ${images.length} screenshots`,
          // A bulk import is exactly when the classifier has the least to go on,
          // so it is exactly when the sweep is worth offering. Offered for any
          // landed capture: /review is in the sidebar now, so this is a shortcut
          // rather than the only door to it.
          landed > 0 ? () => router.push("/review") : undefined,
          "Review",
        );
      } else if (failed) {
        toast("That file could not be read as an image");
      }
    },
    [start, toast, router],
  );

  // Drain anything the Chrome extension queued while this tab was open.
  useEffect(() => {
    if (!ready) return;
    let stop = false;

    const poll = async () => {
      try {
        // Custom header the GET route now requires — see api/ingest/route.ts.
        // The `device` filter is what stops a second Capso tab, in a second
        // browser, from collecting captures meant for this one.
        const res = await fetch(`/api/ingest?device=${encodeURIComponent(deviceToken())}`, {
          headers: { "x-capso-poll": "1" },
        });
        if (!res.ok) return;
        const { items } = (await res.json()) as {
          items: {
            id: string;
            imageDataUrl: string;
            pageUrl?: string;
            pageTitle?: string;
            sourceApp?: string;
          }[];
        };

        // Acknowledged one at a time, after the capture is genuinely stored.
        // The server holds anything unacknowledged and re-offers it, so a throw
        // partway through this loop — or the tab closing — no longer destroys
        // the captures that had already been handed out.
        const stored: string[] = [];
        try {
          for (const item of items) {
            if (stop) break;
            // The extension has always sent the tab's URL and title; until now
            // they were read off the wire and dropped. They are the strongest
            // signal a browser capture carries, for classification and search.
            //
            // The image goes through `downscale` like every other path. It used
            // to be stored exactly as it arrived — `captureVisibleTab` returns
            // an uncompressed retina PNG, so one capture cost megabytes.
            //
            // Skipped if already present: the extension re-sends until this app
            // confirms storage, so a lost ack or a recycled relay instance must
            // cost a redundant upload, never a duplicate capsule. The id comes
            // from the extension precisely so it is stable across those retries.
            if (!seen.current.has(item.id)) {
              seen.current.add(item.id);
              await start(await downscale(item.imageDataUrl), "extension", {
                pageUrl: item.pageUrl ?? null,
                pageTitle: item.pageTitle ?? null,
                sourceApp: item.sourceApp ?? null,
              });
            }
            stored.push(item.id);
          }
        } finally {
          if (stored.length > 0) {
            await fetch("/api/ingest", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ ack: stored }),
            }).catch(() => {
              // Unacknowledged captures are re-offered after a minute, so a
              // failed ack costs a duplicate at worst, never a loss.
            });
          }
        }
      } catch {
        // app runs fine without the extension; a failed poll is not an error
      }
    };

    // Poll regardless of visibility: a capture taken from another tab must land
    // without waiting for the user to come back to Capso. Also drain instantly
    // when the tab is refocused so the overlay appears the moment you look.
    const timer = setInterval(poll, 2500);
    const onVisible = () => void poll();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    void poll();

    return () => {
      stop = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [ready, start]);

  useEffect(() => {
    const onDrop = (e: DragEvent) => {
      const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      if (files.length === 0) return;
      e.preventDefault();
      setDragging(false);
      void ingestFiles(files, "drag");
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
      if (file) void ingestFiles([file], "clipboard");
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
  }, [ingestFiles]);

  if (!ready) return null;

  return (
    <>
      <div className="fixed right-6 bottom-6 z-30 flex items-center gap-2">
        {importing && (
          <span className="rounded-full bg-surface px-3 py-2 text-xs text-muted shadow-lg ring-1 ring-line">
            Importing {importing.done}/{importing.total}…
          </span>
        )}

        <label
          title="Pick real screenshots from your Mac — they are classified like any capture"
          className="cursor-pointer rounded-full bg-surface px-4 py-2.5 text-xs font-medium shadow-lg ring-1 ring-line"
        >
          Import…
          <input
            type="file"
            multiple
            accept="image/*"
            className="sr-only"
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = ""; // re-picking the same files must still fire
              void ingestFiles(files, "web_upload");
            }}
          />
        </label>

        <button
          onClick={async () => void start(await downscale(sampleCapture()), "hotkey_region")}
          title="Stands in for ⌃⇧C until the Mac app is wired up"
          className="rounded-full bg-accent px-4 py-2.5 text-xs font-medium text-accent-ink shadow-lg"
        >
          Capture
        </button>
      </div>

      {dragging && (
        <div className="capso-fade pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-background/70 backdrop-blur-sm">
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
  /**
   * The post-capture overlay is the product's signature moment (05 §2), and it
   * was the one place Confirm did not seat — ScreenshotCard had the motion, the
   * surface everybody actually watches did not.
   */
  const [seating, setSeating] = useState(false);
  const seat = (threadId: string | null) => {
    setSeating(true);
    void assign(s, threadId, "auto");
  };
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
      onAnimationEnd={(e) => {
        if (e.animationName === "capso-seat") setSeating(false);
      }}
      className={`capso-overlay relative w-64 overflow-hidden rounded-xl bg-surface shadow-xl ring-1 ring-line ${
        seating ? "capso-seat capso-crimp" : ""
      }`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- data URI */}
      <img
        src={s.thumbDataUrl ?? s.imageDataUrl ?? ""}
        alt=""
        decoding="async"
        className="h-28 w-full object-cover object-top"
      />

      <div key={state} className="capso-fade space-y-2 p-3">
        {state === "loading" && (
          /* The Reading state, carried by the mark rather than by Tailwind's
             default pulse — this is the provenance rule in motion: the glyph
             is present precisely because Capso, not you, is doing something. */
          <p className="flex items-center gap-2 text-[11px] text-muted">
            <CapsoMark size={13} className="capso-reading" />
            Analysing…
          </p>
        )}

        {state === "suggestion" && (
          <>
            <p className="text-[11px]">
              <span className="text-muted">Project:</span> {threadName(s.suggestedThreadId)}{" "}
              <span className="text-muted">· {Math.round(s.confidence * 100)}%</span>
            </p>
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => seat(s.suggestedThreadId)}
                className="rounded-md bg-accent px-2.5 py-1 text-[11px] text-accent-ink"
              >
                ✓ Confirm
              </button>
              <button
                onClick={() => setAdjusting((a) => !a)}
                className="rounded-md border border-line px-2.5 py-1 text-[11px]"
              >
                Move to…
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
            <button onClick={() => setAdjusting(true)} className="underline underline-offset-2">
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
              // Choosing the shelf yourself is still seating — the capsule
              // takes a slot either way. Only the provenance differs.
              setSeating(true);
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
          <div className="flex items-center gap-3 border-t border-line pt-2 text-[11px] text-muted">
            <button
              onClick={() => router.push(`/threads/${s.threadId ?? s.suggestedThreadId ?? "inbox"}`)}
              title="Open this project's chat"
              className="rounded px-1 py-1 hover:text-accent"
            >
              Ask AI
            </button>
            <button onClick={() => router.push(`/s/${s.id}`)} className="rounded px-1 py-1 hover:text-accent">
              Open
            </button>
            <button
              onClick={async () => {
                // Unlike the detail page's delete, this used to fire on a
                // single click with no confirmation — right next to two
                // non-destructive links sharing an 8px gap.
                if (!confirm(`Delete "${s.title}"? Cannot be undone.`)) return;
                await remove(s);
                onClose();
              }}
              className="rounded px-1 py-1 hover:text-accent"
            >
              Delete
            </button>
            <button
              onClick={onClose}
              aria-label="Close"
              className="ml-auto rounded px-1 py-1 hover:text-accent"
            >
              ✕
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Long edge, in px, that every ingested image is capped at. */
const MAX_EDGE = 1600;
/** Thumb long edge — 14_BACKEND_AND_STORAGE.md §25: WebP, 800 px, quality ~80. */
const THUMB_EDGE = 800;

export type Downscaled = {
  dataUrl: string;
  thumbDataUrl: string;
  aspect: Screenshot["aspect"];
  width: number;
  height: number;
};

/** Draw a bitmap at a given long-edge cap and encode it. */
function encode(bitmap: ImageBitmap, maxEdge: number, type: string, quality: number) {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.drawImage(bitmap, 0, 0, w, h);

  return { dataUrl: canvas.toDataURL(type, quality), w, h };
}

/**
 * Real Mac screenshots are 3–4 MB at @2x, and a browser-tab capture is an
 * uncompressed retina PNG. Stored raw they bloat IndexedDB and every model call.
 *
 * Two variants come out of one decode: the ≤1600px original that OCR and the
 * detail view need, and an 800px WebP thumb that every grid, sidebar, filmstrip
 * and citation renders instead. Before this, a 14px citation chip decoded the
 * same full-size JPEG as the zoom view.
 *
 * WebP is encoded by the canvas itself — no dependency, which is what doc 14
 * means by "generated client-side at capture time".
 */
export async function downscale(src: Blob | string): Promise<Downscaled> {
  const blob = typeof src === "string" ? await (await fetch(src)).blob() : src;
  const bitmap = await createImageBitmap(blob);

  try {
    const full = encode(bitmap, MAX_EDGE, "image/jpeg", 0.85);
    const thumb = encode(bitmap, THUMB_EDGE, "image/webp", 0.8);

    const ratio = full.w / full.h;
    return {
      dataUrl: full.dataUrl,
      // Safari only gained canvas WebP encoding in 16; `toDataURL` silently
      // returns a PNG when the type is unsupported, which would make the
      // "thumb" larger than the original. Fall back to a small JPEG instead.
      thumbDataUrl: thumb.dataUrl.startsWith("data:image/webp")
        ? thumb.dataUrl
        : encode(bitmap, THUMB_EDGE, "image/jpeg", 0.8).dataUrl,
      aspect: ratio > 1.2 ? "wide" : ratio < 0.85 ? "tall" : "square",
      width: full.w,
      height: full.h,
    };
  } finally {
    bitmap.close();
  }
}

/**
 * A fake "screen" for the Capture button. Rendered to PNG via canvas, not SVG:
 * the classify route only accepts base64 raster data, so an SVG sample would
 * silently fall back to simulated output and hide whether the model works.
 */
function sampleCapture() {
  const c = document.createElement("canvas");
  c.width = 900;
  c.height = 560;
  const x = c.getContext("2d");
  if (!x) return "";

  const hue = Math.floor(Math.random() * 360);
  x.fillStyle = SAMPLE_PAGE.paper;
  x.fillRect(0, 0, 900, 560);
  x.fillStyle = `hsl(${hue} 40% 92%)`;
  x.fillRect(0, 0, 900, 76);

  x.fillStyle = SAMPLE_PAGE.ink;
  x.font = "bold 30px -apple-system, sans-serif";
  x.fillText(SAMPLES[0]!.heading, 56, 150);

  x.font = "20px -apple-system, sans-serif";
  x.fillStyle = SAMPLE_PAGE.body;
  SAMPLES[0]!.lines.forEach((line, i) => x.fillText(line, 56, 210 + i * 42));

  x.fillStyle = `hsl(${hue} 55% 55%)`;
  x.fillRect(56, 430, 210, 52);
  x.fillStyle = SAMPLE_PAGE.paper;
  x.font = "18px -apple-system, sans-serif";
  x.fillText(SAMPLES[0]!.cta, 84, 463);

  return c.toDataURL("image/png");
}

/* This canvas fakes a *third-party* web page for the sample captures, so its
   colours depict somebody else's site. They must not be Capso tokens: brand
   colours here would make every sample screenshot look like Capso itself, which
   is the one thing a screenshot of another product should never look like. */
// brand-allow: sample content depicting a third-party page, not Capso chrome
const SAMPLE_PAGE = { paper: "#ffffff", ink: "#141412", body: "#44443f" };

const SAMPLES = [
  {
    heading: "Onboarding checklist",
    lines: [
      "1. Connect your account",
      "2. Import your first data",
      "3. Invite a teammate   完成率 68%",
      "Skip for now",
    ],
    cta: "繼續設定",
  },
];
