"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { CheckCircle, X } from "@phosphor-icons/react";
import { useStore } from "@/lib/store/provider";
import { useToast } from "@/components/toast";
import { classify, fewShotLines } from "@/lib/classify";
import { tagVocabulary } from "@/lib/tags";
import { newId, routeConfidence, type Screenshot } from "@/lib/store";
import { CapsoMark } from "@/components/mark.generated";
import { accountDeviceToken } from "@/lib/device";
import { useAccount } from "@/components/account-gate";
import {
  EXTENSION_POLL_INTERVAL_MS,
  extensionCaptureId,
  shouldStartExtensionPoll,
} from "@/lib/extension-poll";
// Geometry, encoding and the aspect buckets live in one place now — the same
// module the extension mirrors and the Mac app will import, so two surfaces
// capturing the same screen produce the same stored artefact.
// See packages/shared/src/capture.ts.
import {
  aspectOf, contentHash, FULL_QUALITY, FULL_TYPE, fitWithin, MAX_EDGE,
  THUMB_EDGE, THUMB_QUALITY, THUMB_TYPE,
} from "@capso/shared";

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
  const pathname = usePathname();
  const account = useAccount();
  const relayOwnerId = account.userId;
  const [pending, setPending] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState<BulkImportState | null>(null);
  const [extensionBatch, setExtensionBatch] = useState<BulkImportState | null>(null);
  const importActive = importing?.phase === "working";
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
        /** Stable id supplied by the extension, so retries upsert one capsule. */
        id?: string;
        overlay?: boolean;
        /** Lets a batch report the safety milestone before AI reading finishes. */
        onStored?: () => void;
        /** Page context, when the capture came from a browser tab. */
        pageUrl?: string | null;
        pageTitle?: string | null;
        /** Host or app the capture came from — the provenance badge's data. */
        sourceApp?: string | null;
      } = {},
    ) => {
      const id = opts.id ?? newId();
      const now = new Date().toISOString();
      const { dataUrl, thumbDataUrl, aspect, width, height, contentHash } = image;

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
        contentHash,
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
      opts.onStored?.();
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

  // The store changes after every saved capture, which necessarily gives
  // `start` fresh classification context. The relay drain itself must not be
  // torn down mid-batch when that happens, so it reads the latest callback
  // through a ref instead of depending on its identity.
  const startRef = useRef(start);
  useEffect(() => {
    startRef.current = start;
  }, [start]);

  // Persisted extension ids seed the in-tab dedupe set. This covers a reload
  // after storage succeeded but before the acknowledgement reached the relay.
  useEffect(() => {
    for (const screenshot of screenshots) seen.current.add(screenshot.id);
  }, [screenshots]);

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

      if (importActive) {
        toast("Another screenshot import is still running");
        return;
      }

      const overlay = images.length === 1;
      let failed = 0;
      let stored = 0;
      let done = 0;
      if (!overlay) {
        setImporting({
          kind: "import",
          phase: "working",
          total: images.length,
          stored: 0,
          done: 0,
          failed: 0,
          currentName: images[0]!.name,
        });
      }

      for (const [i, file] of images.entries()) {
        if (!overlay) {
          setImporting((current) => current && {
            ...current,
            currentName: file.name,
          });
        }
        try {
          await start(await downscale(file), source, {
            overlay,
            onStored: overlay
              ? undefined
              : () => {
                  stored += 1;
                  setImporting((current) => current && { ...current, stored });
                },
          });
          done += 1;
        } catch {
          failed++; // an unreadable file must not abort the rest of the import
        }
        if (!overlay) {
          setImporting((current) => current && {
            ...current,
            done,
            failed,
            currentName: images[i + 1]?.name ?? file.name,
          });
        }
      }

      if (!overlay) {
        const landed = stored;
        setImporting({
          kind: "import",
          phase: "complete",
          total: images.length,
          stored,
          done,
          failed,
          currentName: null,
        });
        if (failed) {
          toast(`Imported ${landed} of ${images.length} - ${failed} could not be fully read`);
        }
      } else if (failed) {
        toast("That file could not be read as an image");
      }
    },
    [start, toast, importActive],
  );

  // Drain anything the Chrome extension queued while this tab was open.
  useEffect(() => {
    if (!ready) return;
    let stop = false;
    let polling = false;
    let lastStartedAt = Number.NEGATIVE_INFINITY;

    const poll = async () => {
      // Focus, visibility and the interval can all fire together. Only one
      // drain may own a relay batch at a time, otherwise the same in-flight ids
      // can be classified twice before either call reaches the acknowledgement.
      const now = performance.now();
      if (polling || !shouldStartExtensionPoll(now, lastStartedAt)) return;
      polling = true;
      lastStartedAt = now;
      try {
        // Custom header the GET route now requires — see api/ingest/route.ts.
        // The `device` filter is what stops a second Capso tab, in a second
        // browser, from collecting captures meant for this one.
        const relayDevice = await accountDeviceToken(relayOwnerId);
        const res = await fetch(`/api/ingest?device=${encodeURIComponent(relayDevice)}`, {
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
        let failed = 0;
        let completed = 0;
        if (items.length > 0) {
          setExtensionBatch({
            kind: "extension",
            phase: "working",
            total: items.length,
            stored: 0,
            done: 0,
            failed: 0,
            currentName: items[0]?.pageTitle || items[0]?.sourceApp || "Browser capture",
          });
        }
        try {
          for (const [index, item] of items.entries()) {
            if (stop) break;
            const persistedId = extensionCaptureId(item.id);
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
            if (seen.current.has(persistedId)) {
              seen.current.add(persistedId);
              stored.push(item.id);
              completed += 1;
            } else {
              try {
                await startRef.current(await downscale(item.imageDataUrl), "extension", {
                  id: persistedId,
                  overlay: false,
                  pageUrl: item.pageUrl ?? null,
                  pageTitle: item.pageTitle ?? null,
                  sourceApp: item.sourceApp ?? null,
                  onStored: () => {
                    // Do not mark an id as seen before IndexedDB/Supabase has
                    // accepted it. If storage throws, the relay must re-offer it.
                    seen.current.add(persistedId);
                    stored.push(item.id);
                    setExtensionBatch((current) =>
                      current ? { ...current, stored: stored.length } : current,
                    );
                  },
                });
                completed += 1;
              } catch {
                failed += 1;
              }
            }
            setExtensionBatch((current) =>
              current
                ? {
                    ...current,
                    stored: stored.length,
                    done: completed,
                    failed,
                    currentName:
                      items[index + 1]?.pageTitle ||
                      items[index + 1]?.sourceApp ||
                      item.pageTitle ||
                      item.sourceApp ||
                      "Browser capture",
                  }
                : current,
            );
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
          if (items.length > 0) {
            setExtensionBatch({
              kind: "extension",
              phase: "complete",
              total: items.length,
              stored: stored.length,
              done: completed,
              failed,
              currentName: null,
            });
          }
        }
      } catch {
        // app runs fine without the extension; a failed poll is not an error
      } finally {
        polling = false;
      }
    };

    // Poll regardless of visibility: a capture taken from another tab must land
    // without waiting for the user to come back to Capso. Also drain instantly
    // when the tab is refocused so the overlay appears the moment you look.
    const timer = setInterval(poll, EXTENSION_POLL_INTERVAL_MS);
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
  }, [ready, relayOwnerId]);

  useEffect(() => {
    const onDrop = (e: DragEvent) => {
      const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      if (files.length === 0) return;
      e.preventDefault();
      setDragging(false);
      if (importActive) {
        toast("Finish the current import before adding another batch");
        return;
      }
      void ingestFiles(files, "drag");
    };
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
        if (!importActive) setDragging(true);
      }
    };
    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragging(false);
    };
    const onPaste = (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
      const file = item?.getAsFile();
      if (file && importActive) toast("Finish the current import before adding another screenshot");
      else if (file) void ingestFiles([file], "clipboard");
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
  }, [ingestFiles, importActive, toast]);

  if (!ready) return null;

  return (
    <>
      {pathname !== "/extension" && <div className="fixed right-6 bottom-6 z-30 hidden items-center gap-1 rounded-full bg-surface p-1 shadow-lg ring-1 ring-line md:flex">
        <label
          title={importActive ? "A screenshot batch is already being imported" : "Pick real screenshots from your Mac - they are classified like any capture"}
          aria-disabled={importActive}
          className={`rounded-full px-3 py-2 text-xs font-medium transition ${
            importActive ? "cursor-not-allowed text-muted opacity-45" : "cursor-pointer text-muted hover:bg-background hover:text-foreground"
          }`}
        >
          Import…
          <input
            id="capso-import-input"
            type="file"
            multiple
            accept="image/*"
            disabled={importActive}
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
          className="rounded-full bg-accent px-3.5 py-2 text-xs font-semibold text-accent-ink"
        >
          Capture
        </button>
      </div>}

      {importing && (
        <BulkImportStatus
          value={importing}
          onDismiss={() => setImporting(null)}
          onOpenLibrary={() => router.push("/library")}
          onReview={() => router.push("/review")}
        />
      )}

      {extensionBatch && (
        <BulkImportStatus
          value={extensionBatch}
          onDismiss={() => setExtensionBatch(null)}
          onOpenLibrary={() => router.push("/library")}
          onReview={() => router.push("/review")}
          raised={Boolean(importing)}
        />
      )}

      {dragging && (
        <div className="capso-fade pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-background/70 backdrop-blur-sm">
          <p className="rounded-xl border-2 border-dashed border-accent px-8 py-6 text-sm">
            Drop to capture
          </p>
        </div>
      )}

      <div className="fixed right-6 bottom-[140px] z-40 flex flex-col-reverse gap-3 md:bottom-20">
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

type BulkImportState = {
  kind: "import" | "extension";
  phase: "working" | "complete";
  total: number;
  stored: number;
  done: number;
  failed: number;
  currentName: string | null;
};

function BulkImportStatus({
  value,
  onDismiss,
  onOpenLibrary,
  onReview,
  raised = false,
}: {
  value: BulkImportState;
  onDismiss: () => void;
  onOpenLibrary: () => void;
  onReview: () => void;
  raised?: boolean;
}) {
  const processed = value.done + value.failed;
  const percent = Math.round((processed / value.total) * 100);
  const working = value.phase === "working";
  const landed = value.stored;

  return (
    <section
      role="region"
      aria-label="Screenshot import status"
      className={`capso-overlay fixed right-4 z-40 w-[min(350px,calc(100vw-32px))] rounded-[20px] border border-line bg-surface p-4 shadow-xl md:right-6 ${
        raised ? "bottom-[360px] md:bottom-[276px]" : "bottom-[148px] md:bottom-20"
      }`}
    >
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-background text-muted">
          {working ? (
            <CapsoMark size={22} className="capso-reading" />
          ) : (
            <CheckCircle size={22} weight="fill" className="text-foreground" />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold">
                {working
                  ? value.kind === "extension"
                    ? `Receiving ${value.total} browser captures`
                    : `Importing ${value.total} screenshots`
                  : value.kind === "extension"
                    ? "Browser captures received"
                    : "Import complete"}
              </h2>
              <p aria-live="polite" aria-atomic="true" className="mt-0.5 text-xs leading-relaxed text-muted">
                {working
                  ? `${value.kind === "extension" ? "Organising" : "Reading"} ${Math.min(processed + 1, value.total)} of ${value.total}`
                  : `${landed} screenshot${landed === 1 ? "" : "s"} added to your memory`}
              </p>
            </div>
            {!working && (
              <button
                type="button"
                onClick={onDismiss}
                aria-label="Dismiss import status"
                className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-muted hover:bg-background hover:text-foreground"
              >
                <X size={14} />
              </button>
            )}
          </div>

          {working && value.currentName && (
            <p className="mt-2 truncate text-xs" title={value.currentName}>{value.currentName}</p>
          )}
        </div>
      </div>

      <div
        role="progressbar"
        aria-label="Screenshot import progress"
        aria-valuemin={0}
        aria-valuemax={value.total}
        aria-valuenow={processed}
        className="mt-4 h-1.5 overflow-hidden rounded-full bg-line"
      >
        <span
          className="block h-full rounded-full bg-accent transition-[width] duration-200 ease-out"
          style={{ width: `${working ? percent : 100}%` }}
        />
      </div>

      <div className="mt-2 flex items-center gap-2 text-xs tabular-nums text-muted">
        <span>{value.stored} saved</span>
        <span aria-hidden="true">·</span>
        <span>{value.done} read</span>
        {value.failed > 0 && (
          <>
            <span aria-hidden="true">·</span>
            <span className="text-danger">{value.failed} failed</span>
          </>
        )}
        <span className="ml-auto">{working ? `${percent}%` : "Done"}</span>
      </div>

      {working ? (
        <p className="mt-3 border-t border-line pt-3 text-xs leading-relaxed text-muted">
          {value.kind === "extension"
            ? "The extension keeps every capture until Capso confirms it is safely stored."
            : "Images are safe as soon as they are saved. You can keep using Capso while it reads the rest."}
        </p>
      ) : (
        <div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
          <button type="button" onClick={onOpenLibrary} className="rounded-full bg-accent px-3 py-2 text-xs font-semibold text-accent-ink">
            View folders
          </button>
          {landed > 0 && (
            <button type="button" onClick={onReview} className="rounded-full border border-line px-3 py-2 text-xs font-medium text-muted hover:text-foreground">
              Review suggestions
            </button>
          )}
        </div>
      )}
    </section>
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
             default pulse - this is the provenance rule in motion: the glyph
             is present precisely because Capso, not you, is doing something. */
          <p className="flex items-center gap-2 text-xs text-muted">
            <CapsoMark size={13} className="capso-reading" />
            Analysing…
          </p>
        )}

        {state === "suggestion" && (
          <>
            <p className="text-xs">
              <span className="text-muted">Project:</span> {threadName(s.suggestedThreadId)}{" "}
              <span className="text-muted">· {Math.round(s.confidence * 100)}%</span>
            </p>
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => seat(s.suggestedThreadId)}
                className="rounded-md bg-accent px-2.5 py-1 text-xs text-accent-ink"
              >
                ✓ Confirm
              </button>
              <button
                onClick={() => setAdjusting((a) => !a)}
                className="rounded-md border border-line px-2.5 py-1 text-xs"
              >
                Move to…
              </button>
              <button onClick={onClose} className="px-2 py-1 text-xs text-muted">
                Ignore
              </button>
            </div>
          </>
        )}

        {state === "confirmed" && (
          <p className="text-xs">
            Saved to <span className="font-medium">{threadName(s.threadId)}</span>{" "}
            <button onClick={() => setAdjusting(true)} className="underline underline-offset-2">
              edit
            </button>
          </p>
        )}

        {state === "timeout" && (
          <p className="text-xs text-muted">Saved to Inbox - not sure where it belongs.</p>
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
            className="w-full rounded-md border border-line bg-background px-2 py-1 text-xs"
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
          <div className="flex items-center gap-3 border-t border-line pt-2 text-xs text-muted">
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

export type Downscaled = {
  dataUrl: string;
  thumbDataUrl: string;
  aspect: Screenshot["aspect"];
  width: number;
  height: number;
  /**
   * Fingerprint of the bytes actually stored, computed here because here is the
   * only place they are final.
   *
   * The extension already hashes its own compressed output and sends it — but
   * the web app then re-decodes and re-encodes that image, so the hash it sent
   * described bytes that no longer exist. It was accepted by `/api/ingest`,
   * carried through the queue, and then dropped on the floor by the drain.
   * Hashing at the end of the one pipeline every capture goes through means the
   * hash always matches what is in Storage, whichever surface took it.
   */
  contentHash: string;
};

/** Draw a bitmap at a given long-edge cap and encode it. */
function encode(bitmap: ImageBitmap, maxEdge: number, type: string, quality: number) {
  const { width: w, height: h } = fitWithin(bitmap.width, bitmap.height, maxEdge);

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
    const full = encode(bitmap, MAX_EDGE, FULL_TYPE, FULL_QUALITY);
    const thumb = encode(bitmap, THUMB_EDGE, THUMB_TYPE, THUMB_QUALITY);

    return {
      dataUrl: full.dataUrl,
      // Safari only gained canvas WebP encoding in 16; `toDataURL` silently
      // returns a PNG when the type is unsupported, which would make the
      // "thumb" larger than the original. Fall back to a small JPEG instead.
      thumbDataUrl: thumb.dataUrl.startsWith(`data:${THUMB_TYPE}`)
        ? thumb.dataUrl
        : encode(bitmap, THUMB_EDGE, "image/jpeg", THUMB_QUALITY).dataUrl,
      aspect: aspectOf(full.w, full.h),
      width: full.w,
      height: full.h,
      contentHash: await contentHash(full.dataUrl),
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
