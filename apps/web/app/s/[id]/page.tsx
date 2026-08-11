"use client";

import { use, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useStore } from "@/lib/store/provider";
import { getImage, type Intent } from "@/lib/store";
import { imageFor, INTENT_LABEL, INTENTS, SkeletonGrid } from "@/components/ui";
import { useReclassify } from "@/lib/reclassify";
import { AnnotateEditor } from "@/components/annotate";
import { downscale } from "@/components/capture";
import { useToast } from "@/components/toast";

async function copyImagePixels(source: string): Promise<void> {
  const image = new Image();
  image.src = source;
  await image.decode();

  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Capso could not prepare the image clipboard.");
  context.drawImage(image, 0, 0);
  const png = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Capso could not encode the image clipboard."))),
      "image/png",
    );
  });
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

/**
 * Screenshot detail — the "what does this actually tell me" surface.
 * Elements are the list in 13_WEB_APP_PLAN.md; opening it writes a revisit (F5).
 */
export default function DetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { ready, get, screenshots, threads, threadName, assign, saveWhySaved, saveIntent, addTag, dropTag, remove, visit, patch } =
    useStore();
  const { reread, busy } = useReclassify();
  const toast = useToast();
  const s = get(id);

  // Ordered the same way the library shows them, so ←/→ match what you just scrolled.
  // Memoized — this used to re-sort the entire (not just this thread's)
  // collection synchronously on every render, including every keystroke typed
  // into the "why saved" or tag inputs below.
  const ordered = useMemo(
    () => [...screenshots].filter((x) => !x.archived).sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)),
    [screenshots],
  );
  const idx = ordered.findIndex((x) => x.id === id);
  const prev = idx > 0 ? ordered[idx - 1] : undefined;
  const next = idx >= 0 && idx < ordered.length - 1 ? ordered[idx + 1] : undefined;

  const [annotating, setAnnotating] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [ocrOpen, setOcrOpen] = useState(true);
  const [draft, setDraft] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState("");
  const visited = useRef(false);

  /**
   * The full-size original, fetched on demand. It no longer rides on the row -
   * keeping every original in memory is what made loading the library expensive
   * — so this is the one screen that pays to read it back. Until it arrives,
   * `imageFor` renders the 800px thumb, so the page is never empty.
   */
  const [original, setOriginal] = useState<{ id: string; data: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    void getImage(id).then((data) => {
      if (live) setOriginal({ id, data });
    });
    return () => {
      live = false;
    };
  }, [id]);

  // Keyed by id rather than cleared on navigation: resetting state synchronously
  // in the effect is a cascading render, and comparing ids also closes the
  // window where the previous capture's original showed under the new title.
  const loaded = original?.id === id ? original.data : null;
  const fullImage = loaded ?? (s ? imageFor(s) : "");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName))
        return;
      if (e.key === "ArrowLeft" && prev) router.push(`/s/${prev.id}`);
      if (e.key === "ArrowRight" && next) router.push(`/s/${next.id}`);
      if (e.key === "Escape") router.push("/");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prev, next, router]);

  useEffect(() => {
    if (s && !visited.current) {
      visited.current = true;
      void visit(s.id, "opened_detail");
    }
  }, [s, visit]);

  if (!ready) return <SkeletonGrid />;
  if (!s)
    return (
      <div className="text-sm">
        <p>That capture is gone.</p>
        <Link href="/library" className="mt-2 inline-block text-xs underline underline-offset-2">
          Back to folders
        </Link>
      </div>
    );

  const flash = (what: string) => {
    setCopied(what);
    setTimeout(() => setCopied(null), 1200);
  };

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      {annotating && fullImage && (
        <AnnotateEditor
          src={fullImage}
          onCancel={() => setAnnotating(false)}
          onSave={async (dataUrl, redacted) => {
            // Straight back through the pipeline every other capture uses, so an
            // annotated image gets the same cap, the same thumb and a hash of the
            // bytes that are actually stored — rather than a second, divergent
            // encoding path that only annotated captures take.
            const img = await downscale(dataUrl);
            await patch(id, {
              imageDataUrl: img.dataUrl,
              thumbDataUrl: img.thumbDataUrl,
              width: img.width,
              height: img.height,
              aspect: img.aspect,
              contentHash: img.contentHash,
            });
            setAnnotating(false);
            setOriginal({ id, data: img.dataUrl });
            // 05 §3 names this as a known limitation: OCR ran on the unblurred
            // image, so the text Capso remembers still contains what was just
            // painted over. Rather than only documenting it, offer the re-read
            // that actually clears it.
            if (redacted) {
              toast(
                "Blurred - but the text Capso already read still contains it.",
                () => {
                  const cur = get(id);
                  if (cur) void reread(cur);
                },
                "Read again",
              );
            } else {
              toast("Annotation saved");
            }
          }}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="mb-3 flex items-center gap-2 text-xs">
          <Link href="/library" className="text-muted hover:text-accent">
            ← Folders
          </Link>
          <span className="ml-auto text-muted">
            {idx + 1} of {ordered.length}
          </span>
          <button
            disabled={!prev}
            onClick={() => prev && router.push(`/s/${prev.id}`)}
            className="rounded-md border border-line px-2 py-1 disabled:opacity-30"
            aria-label="Previous capture"
          >
            ←
          </button>
          <button
            disabled={!next}
            onClick={() => next && router.push(`/s/${next.id}`)}
            className="rounded-md border border-line px-2 py-1 disabled:opacity-30"
            aria-label="Next capture"
          >
            →
          </button>
        </div>

        <button
          onClick={() => setZoom((z) => !z)}
          // Zoomed, the image renders at native decoded width (up to 1600px)
          // with no ancestor containing the overflow — this used to blow out
          // the whole page horizontally on phone-width viewports.
          className="block w-full cursor-zoom-in overflow-x-auto"
          aria-label={zoom ? "Zoom out" : "Zoom in"}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- data URI */}
          <img
            src={fullImage}
            alt={s.title}
            className={`rounded-xl border border-line bg-surface ${
              // At rest the whole capture fits the window, so a tall screenshot
              // is something you look at rather than something you scroll past;
              // zoom is what gives actual pixels. `object-contain` because this
              // is the one place nothing may be cropped away.
              zoom ? "w-auto max-w-none" : "max-h-[78vh] w-full object-contain"
            }`}
          />
        </button>

        {/* Filmstrip of neighbours (Apple Photos / Faire) — position in the set is
            visible, and moving is one click instead of a blind arrow press. */}
        <div className="mt-3 flex gap-1.5 overflow-x-auto pb-1">
          {ordered.slice(Math.max(0, idx - 4), idx + 5).map((n) => (
            <Link
              key={n.id}
              href={`/s/${n.id}`}
              className={`w-14 shrink-0 overflow-hidden rounded-md border transition-[border-color,opacity] duration-[120ms] ${
                n.id === s.id ? "border-accent" : "border-line opacity-60 hover:opacity-100"
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- data URI */}
              <img
                src={imageFor(n, "thumb")}
                alt=""
                loading="lazy"
                decoding="async"
                className="h-10 w-full object-cover object-top"
              />
            </Link>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <button
            onClick={async () => {
              try {
                await copyImagePixels(fullImage);
                await visit(s.id, "copied");
                flash("image");
              } catch {
                toast("Could not copy image pixels. Download the PNG instead.");
              }
            }}
            className="rounded-md border border-line px-3 py-1.5"
          >
            Copy image
          </button>
          <a
            href={fullImage}
            download={`${s.title}.png`}
            className="rounded-md border border-line px-3 py-1.5"
          >
            Download
          </a>
          {/* M2. Only offered once the full-size original is in hand — annotating
              the 800px thumb would quietly downgrade the capture on save. */}
          {fullImage && (
            <button
              onClick={() => setAnnotating(true)}
              className="rounded-md border border-line px-3 py-1.5"
            >
              Annotate
            </button>
          )}
          {/* Quiet here, prominent in the failure banner above. Re-reading a
              capture that read fine is still worth offering - the guess improves
              once there are more projects and more corrections to learn from. */}
          {s.status === "done" && (
            <button
              onClick={() => void reread(s)}
              disabled={busy === s.id}
              className="rounded-md border border-line px-3 py-1.5 disabled:opacity-40"
            >
              {busy === s.id ? "Reading…" : "Read again"}
            </button>
          )}
          <button
            onClick={async () => {
              if (
                !confirm(
                  "Deletes this cloud copy, its OCR text and library references. A Mac original retained by the Capso app stays local. Cannot be undone.",
                )
              )
                return;
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
          <h1 className="text-xl font-semibold tracking-tight">{s.title}</h1>
          <p className="mt-1 text-xs text-muted">
            {new Date(s.capturedAt).toLocaleString("en-GB")} · {s.source.replace(/_/g, " ")}
          </p>
          {/* File meta line, Air/Squarespace style. Reads the loaded original
              rather than the row - the row no longer carries it - and reports
              the real format instead of calling every capture "PNG", which was
              wrong for the whole import path since it encodes JPEG. */}
          <p className="mt-1 text-xs tracking-wide text-muted uppercase">
            {formatOf(fullImage)} · {s.type.replace(/_/g, " ")}
            {s.width && s.height ? ` · ${s.width}×${s.height}` : ""} ·{" "}
            {Math.max(1, Math.round(fullImage.length / 1024))} KB
          </p>
        </div>

        {/* A failed classification used to be a dead end here: no title, no
            summary, no OCR text, and the only "Try again" in the product was in
            the Inbox - which this capture leaves the moment it is filed. */}
        {s.status === "unprocessed" && (
          <div className="rounded-lg border border-line bg-surface p-3">
            <p className="text-xs font-medium">Capso couldn&apos;t read this one</p>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              No title, summary or text was extracted, so it will not turn up in search. Nothing
              about the image is lost. Only what was read from it is missing.
            </p>
            <button
              onClick={() => void reread(s)}
              disabled={busy === s.id}
              className="mt-2 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink disabled:opacity-40"
            >
              {busy === s.id ? "Reading…" : "Try again"}
            </button>
          </div>
        )}

        <Field label="Summary">
          <p className="text-xs leading-relaxed">{s.summary}</p>
        </Field>

        {/* Editable — owner decision; every edit is a training signal. */}
        <Field label="Why I saved this">
          {draft === null ? (
            <button
              onClick={() => setDraft(s.whySaved)}
              className="w-full text-left text-xs leading-relaxed hover:underline"
            >
              {s.whySaved || <span className="text-muted">Add a reason…</span>}
            </button>
          ) : (
            <div className="space-y-2">
              <textarea
                aria-label="Why I saved this"
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
                  className="rounded-md bg-accent px-3 py-1 text-xs text-accent-ink"
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

        <Field label="Tags">
          <div className="flex flex-wrap gap-1.5">
            {s.userTags.map((t) => (
              <Tag key={`u-${t}`} label={t} mine onRemove={() => void dropTag(s, t)} />
            ))}
            {s.tags.map((t) => (
              <Tag key={`a-${t}`} label={t} onRemove={() => void dropTag(s, t)} />
            ))}
            {s.tags.length === 0 && s.userTags.length === 0 && (
              <span className="text-xs text-muted">No tags yet.</span>
            )}
          </div>

          <input
            aria-label="Add a tag"
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            // Handled on the key rather than via a <form>: a single-input form
            // with no submit button relies on implicit submission, which is the
            // kind of thing that quietly stops working. Enter should mean Enter.
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              void addTag(s, tagDraft);
              setTagDraft("");
            }}
            placeholder="Add a tag…"
            className="mt-2 w-full rounded-md border border-line bg-surface px-2 py-1.5 text-xs"
          />

          {s.tags.length > 0 && (
            // Say which ones were guessed. Without this the owner cannot tell
            // what Capso inferred from what they told it, and removing a tag
            // stops reading as feedback.
            <p className="mt-1.5 text-xs text-muted">
              Unfilled tags are suggestions - removing one teaches Capso.
            </p>
          )}
        </Field>

        <Field label="Intent">
          <select
            aria-label="Intent"
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
            aria-label="Project"
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
            <p className="mt-1 text-xs text-muted">
              Capso suggested {threadName(s.suggestedThreadId)} ({Math.round(s.confidence * 100)}%)
            </p>
          )}
        </Field>

        <Field label={`OCR text (${s.ocrText.length} chars)`}>
          <button onClick={() => setOcrOpen((o) => !o)} className="text-xs underline underline-offset-2">
            {ocrOpen ? "Collapse" : "Expand"}
          </button>
          {ocrOpen && (
            <>
              <pre className="mt-2 max-h-56 overflow-auto rounded-md border border-line bg-surface p-2 text-xs leading-relaxed whitespace-pre-wrap">
                {s.ocrText || "No text found."}
              </pre>
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(s.ocrText);
                  flash("text");
                }}
                className="mt-1.5 text-xs underline underline-offset-2"
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

/**
 * One tag chip. `mine` fills it; a suggestion stays outlined — the same visual
 * split Air uses to separate custom metadata from smart metadata, so "who said
 * this" is legible at a glance rather than needing a legend.
 */
function Tag({ label, mine, onRemove }: { label: string; mine?: boolean; onRemove: () => void }) {
  return (
    <span
      className={`group inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
        mine ? "bg-accent/12 text-foreground" : "border border-line text-muted"
      }`}
    >
      {label}
      <button
        onClick={onRemove}
        aria-label={`Remove tag ${label}`}
        className="opacity-0 transition-opacity duration-[120ms] group-hover:opacity-100 focus-visible:opacity-100 hover:text-accent"
      >
        ×
      </button>
    </span>
  );
}

/** "data:image/webp;base64,…" → "WEBP". Falls back for the placeholder SVG. */
function formatOf(dataUrl: string) {
  return dataUrl.match(/^data:image\/([a-z+]+)/i)?.[1]?.toUpperCase() ?? "Unknown";
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-xs uppercase tracking-wide text-muted">{label}</p>
      {children}
    </div>
  );
}
