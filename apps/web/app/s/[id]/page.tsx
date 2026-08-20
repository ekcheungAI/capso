"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { LinkSimple, ShieldCheck, X } from "@phosphor-icons/react";
import { useStore } from "@/lib/store/provider";
import { getImage, type Intent } from "@/lib/store";
import { imageFor, INTENT_LABEL, INTENTS, SkeletonGrid } from "@/components/ui";
import { useReclassify } from "@/lib/reclassify";
import { AnnotateEditor } from "@/components/annotate";
import { downscale } from "@/components/capture";
import { useToast } from "@/components/toast";
import { useAccount } from "@/components/account-gate";
import { accountFetch } from "@/lib/supabase/client";
import { SHARE_EXPIRIES, shareLinkState, type ShareLink } from "@/lib/share-link";
import { captureDetailPresentation, imageFilePresentation } from "@/lib/capture-detail";

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
  const searchParams = useSearchParams();
  const account = useAccount();
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
  const sharePreview = process.env.NODE_ENV !== "production" && searchParams.get("preview") === "share";
  const [sharing, setSharing] = useState(sharePreview);
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
        <Link href="/library" className="mt-2 inline-flex min-h-11 items-center text-xs underline underline-offset-2 sm:min-h-0">
          Back to folders
        </Link>
      </div>
    );

  const provenance = captureDetailPresentation(s, account.mode);
  const file = imageFilePresentation(loaded ?? s.imageDataUrl ?? "", s.originalPath);

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
      {sharing && (
        <ShareDialog
          screenshotId={s?.id ?? id}
          preview={sharePreview}
          onClose={() => setSharing(false)}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="mb-3 flex items-center gap-2 text-xs">
          <Link href="/library" className="inline-flex min-h-11 items-center text-muted hover:text-accent sm:min-h-0">
            ← Folders
          </Link>
          <span className="ml-auto text-muted">
            {idx + 1} of {ordered.length}
          </span>
          <button
            disabled={!prev}
            onClick={() => prev && router.push(`/s/${prev.id}`)}
            className="min-h-11 min-w-11 rounded-md border border-line px-2 py-1 disabled:opacity-30 sm:min-h-0 sm:min-w-0"
            aria-label="Previous capture"
          >
            ←
          </button>
          <button
            disabled={!next}
            onClick={() => next && router.push(`/s/${next.id}`)}
            className="min-h-11 min-w-11 rounded-md border border-line px-2 py-1 disabled:opacity-30 sm:min-h-0 sm:min-w-0"
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
              aria-label={`Open ${n.title}${n.id === s.id ? ", current capture" : ""}`}
              aria-current={n.id === s.id ? "page" : undefined}
              className={`min-h-11 w-14 shrink-0 overflow-hidden rounded-md border transition-[border-color,opacity] duration-[120ms] sm:min-h-0 ${
                n.id === s.id ? "border-accent" : "border-line opacity-60 hover:opacity-100"
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- data URI */}
              <img
                src={imageFor(n, "thumb")}
                alt=""
                loading="lazy"
                decoding="async"
                className="h-11 w-full object-cover object-top sm:h-10"
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
            className="min-h-11 rounded-md border border-line px-3 py-1.5 sm:min-h-0"
          >
            Copy image
          </button>
          <a
            href={fullImage}
            download={`${s.title}.png`}
            className="inline-flex min-h-11 items-center rounded-md border border-line px-3 py-1.5 sm:min-h-0"
          >
            Download
          </a>
          {/* M2. Only offered once the full-size original is in hand — annotating
              the 800px thumb would quietly downgrade the capture on save. */}
          {fullImage && (
            <button
              onClick={() => setAnnotating(true)}
              className="min-h-11 rounded-md border border-line px-3 py-1.5 sm:min-h-0"
            >
              Annotate
            </button>
          )}
          <button
            onClick={() => {
              if (account.mode !== "signed_in" && !sharePreview) {
                toast("Connect your Capso account before creating a private link.");
                return;
              }
              if (!s.originalPath && !sharePreview) {
                toast("This capture must finish syncing before it can be shared.");
                return;
              }
              setSharing(true);
            }}
            className="min-h-11 rounded-md border border-line px-3 py-1.5 sm:min-h-0"
          >Share</button>
          {/* Quiet here, prominent in the failure banner above. Re-reading a
              capture that read fine is still worth offering - the guess improves
              once there are more projects and more corrections to learn from. */}
          {s.status === "done" && (
            <button
              onClick={() => void reread(s)}
              disabled={busy === s.id}
              className="min-h-11 rounded-md border border-line px-3 py-1.5 disabled:opacity-40 sm:min-h-0"
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
            className="min-h-11 rounded-md px-3 py-1.5 text-muted hover:text-accent sm:min-h-0"
          >
            Delete
          </button>
          {copied && <span role="status" aria-live="polite" className="text-muted">Copied {copied}</span>}
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
            {file.format} · {s.type.replace(/_/g, " ")}
            {s.width && s.height ? ` · ${s.width}×${s.height}` : ""}
            {file.size ? ` · ${file.size}` : ""}
          </p>
        </div>

        <dl
          aria-label="Capture provenance and availability"
          className="divide-y divide-line rounded-xl border border-line bg-surface px-3"
        >
          <div className="py-3">
            <dt className="text-[11px] font-medium uppercase tracking-wide text-muted">Captured with</dt>
            <dd className="mt-1 text-xs">
              <span className="block font-medium">{provenance.origin.label}</span>
              <span className="mt-0.5 block leading-relaxed text-muted">{provenance.origin.detail}</span>
              {provenance.sourceUrl && (
                <a
                  href={provenance.sourceUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-1 inline-flex min-h-11 items-center text-accent underline underline-offset-2 sm:min-h-0"
                >
                  Open source page ↗
                </a>
              )}
            </dd>
          </div>
          <div className="py-3" data-state={provenance.availability.state}>
            <dt className="text-[11px] font-medium uppercase tracking-wide text-muted">Library copy</dt>
            <dd className="mt-1 text-xs">
              <span className="flex items-center gap-2 font-medium">
                <span
                  aria-hidden="true"
                  className={`h-1.5 w-1.5 rounded-full ${
                    provenance.availability.state === "waiting" ? "bg-muted" : "bg-accent"
                  }`}
                />
                {provenance.availability.label}
              </span>
              <span className="mt-0.5 block leading-relaxed text-muted">{provenance.availability.detail}</span>
            </dd>
          </div>
          <div className="py-3">
            <dt className="text-[11px] font-medium uppercase tracking-wide text-muted">Editing</dt>
            <dd className="mt-1 text-xs">
              <span className="block font-medium">{provenance.editing.label}</span>
              <span className="mt-0.5 block leading-relaxed text-muted">{provenance.editing.detail}</span>
            </dd>
          </div>
        </dl>

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
              className="mt-2 min-h-11 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink disabled:opacity-40 sm:min-h-0"
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
              className="min-h-11 w-full text-left text-xs leading-relaxed hover:underline sm:min-h-0"
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
                className="min-h-11 w-full rounded-md border border-line bg-surface p-2 text-xs"
              />
              <div className="flex gap-2">
                <button
                  onClick={async () => {
                    await saveWhySaved(s, draft.trim());
                    setDraft(null);
                  }}
                  className="min-h-11 rounded-md bg-accent px-3 py-1 text-xs text-accent-ink sm:min-h-0"
                >
                  Save
                </button>
                <button onClick={() => setDraft(null)} className="min-h-11 min-w-11 text-xs text-muted sm:min-h-0 sm:min-w-0">
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
            className="mt-2 min-h-11 w-full rounded-md border border-line bg-surface px-2 py-1.5 text-xs"
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
            className="min-h-11 w-full rounded-md border border-line bg-surface px-2 py-1.5 text-xs"
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
            className="min-h-11 w-full rounded-md border border-line bg-surface px-2 py-1.5 text-xs"
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
          <button onClick={() => setOcrOpen((o) => !o)} className="min-h-11 min-w-11 text-xs underline underline-offset-2 sm:min-h-0 sm:min-w-0">
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
                className="mt-1.5 min-h-11 min-w-11 text-xs underline underline-offset-2 sm:min-h-0 sm:min-w-0"
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
      className={`group inline-flex min-h-11 items-center gap-1 rounded-full py-0.5 pl-3 text-xs sm:min-h-0 ${
        mine ? "bg-accent/12 text-foreground" : "border border-line text-muted"
      }`}
    >
      {label}
      <button
        onClick={onRemove}
        aria-label={`Remove tag ${label}`}
        className="min-h-11 min-w-11 opacity-0 transition-opacity duration-[120ms] group-hover:opacity-100 focus-visible:opacity-100 hover:text-accent sm:min-h-0 sm:min-w-0"
      >
        ×
      </button>
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-xs uppercase tracking-wide text-muted">{label}</p>
      {children}
    </div>
  );
}

function ShareDialog({
  screenshotId,
  preview,
  onClose,
}: {
  screenshotId: string;
  preview: boolean;
  onClose: () => void;
}) {
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [expiresInSeconds, setExpiresInSeconds] = useState(86_400);
  const [passwordProtected, setPasswordProtected] = useState(false);
  const [password, setPassword] = useState("");
  const [oneTime, setOneTime] = useState(false);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [createdLinkId, setCreatedLinkId] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [busy, setBusy] = useState<"load" | "create" | string | null>("load");
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const focusedRef = useRef(false);

  const load = useCallback(async () => {
    await Promise.resolve();
    setBusy("load");
    setError(null);
    if (preview) {
      setLinks([{
        id: "33333333-3333-4333-8333-333333333333",
        createdAt: new Date(Date.now() - 3_600_000).toISOString(),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        hasPassword: true,
        oneTime: false,
        consumedAt: null,
        revokedAt: null,
        viewCount: 2,
      }]);
      setBusy(null);
      return;
    }
    try {
      const response = await accountFetch("/api/share-links", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "list", screenshotId }),
      });
      const result = await response.json() as { links?: ShareLink[]; error?: string };
      if (!response.ok || !result.links) throw new Error(result.error ?? "Private links could not be loaded.");
      setLinks(result.links);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Private links could not be loaded.");
    } finally {
      setBusy(null);
    }
  }, [preview, screenshotId]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [load]);
  useEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => openerRef.current?.focus();
  }, []);
  useEffect(() => {
    if (busy === null && !focusedRef.current) {
      focusedRef.current = true;
      closeRef.current?.focus();
    }
  }, [busy]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && busy === null) onClose();
      if (event.key === "Tab" && dialogRef.current) {
        const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        )].filter((element) => element.getClientRects().length > 0);
        if (!focusable.length) return;
        const first = focusable[0]!;
        const last = focusable.at(-1)!;
        const active = document.activeElement;
        if (event.shiftKey && (active === first || !dialogRef.current.contains(active))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  async function createLink() {
    setBusy("create");
    setError(null);
    try {
      if (passwordProtected && (password.length < 6 || new TextEncoder().encode(password).length > 128)) {
        throw new Error("Use a password between 6 and 128 bytes.");
      }
      if (preview) {
        const token = `sh_${"A".repeat(43)}`;
        const linkId = "44444444-4444-4444-8444-444444444444";
        setCreatedToken(token);
        setCreatedLinkId(linkId);
        setLinkCopied(false);
        setLinks((current) => [{
          id: linkId,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + expiresInSeconds * 1_000).toISOString(),
          hasPassword: passwordProtected,
          oneTime,
          consumedAt: null,
          revokedAt: null,
          viewCount: 0,
        }, ...current]);
        setPassword("");
        return;
      }
      const response = await accountFetch("/api/share-links", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "create",
          screenshotId,
          expiresInSeconds,
          password: passwordProtected ? password : null,
          oneTime,
        }),
      });
      const result = await response.json() as { token?: string; link?: ShareLink; error?: string };
      if (!response.ok || !result.token || !result.link) throw new Error(result.error ?? "Private link could not be created.");
      setCreatedToken(result.token);
      setCreatedLinkId(result.link.id);
      setLinkCopied(false);
      setLinks((current) => [result.link!, ...current]);
      setPassword("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Private link could not be created.");
    } finally {
      setBusy(null);
    }
  }

  async function revoke(linkId: string) {
    setBusy(linkId);
    setError(null);
    try {
      if (!preview) {
        const response = await accountFetch("/api/share-links", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "revoke", screenshotId, linkId }),
        });
        if (!response.ok) throw new Error("Private link could not be revoked.");
      }
      setLinks((current) => current.map((link) => link.id === linkId
        ? { ...link, revokedAt: new Date().toISOString() }
        : link));
      if (createdLinkId === linkId) {
        setCreatedToken(null);
        setCreatedLinkId(null);
        setLinkCopied(false);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Private link could not be revoked.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-foreground/35 p-3 backdrop-blur-sm" role="presentation">
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-dialog-title"
        className="grid max-h-[calc(100vh-1.5rem)] w-full max-w-2xl grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-[24px] border border-line bg-surface shadow-2xl"
      >
        <header className="flex items-start gap-4 border-b border-line px-5 py-4 sm:px-6">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent/12 text-accent">
            <LinkSimple size={20} weight="bold" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">Private delivery</p>
            <h2 id="share-dialog-title" className="mt-0.5 text-xl font-semibold tracking-tight">Share this capture</h2>
            <p className="mt-1 text-xs leading-5 text-muted">Only the image is shared. Title, OCR, tags and projects stay private.</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close sharing"
            disabled={busy !== null}
            onClick={onClose}
            className="ml-auto grid h-11 w-11 shrink-0 place-items-center rounded-full border border-line disabled:opacity-50"
          ><X size={16} /></button>
        </header>

        <div className="overflow-y-auto px-5 py-5 sm:px-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1.5 text-xs font-semibold">
              Expires
              <select
                value={expiresInSeconds}
                onChange={(event) => setExpiresInSeconds(Number(event.currentTarget.value))}
                className="min-h-11 rounded-xl border border-line bg-background px-3 text-sm font-normal"
              >
                {SHARE_EXPIRIES.map((choice) => <option key={choice.seconds} value={choice.seconds}>{choice.label}</option>)}
              </select>
            </label>
            <label className="flex min-h-11 items-center gap-3 rounded-xl border border-line bg-background px-3 text-sm">
              <input type="checkbox" checked={oneTime} onChange={(event) => setOneTime(event.currentTarget.checked)} />
              <span><strong className="block text-xs">One-time link</strong><small className="text-muted">Consumes after image delivery</small></span>
            </label>
          </div>

          <label className="mt-4 flex min-h-11 items-center gap-3 rounded-xl border border-line bg-background px-3 text-sm">
            <input
              type="checkbox"
              checked={passwordProtected}
              onChange={(event) => {
                setPasswordProtected(event.currentTarget.checked);
                if (!event.currentTarget.checked) setPassword("");
              }}
            />
            <span><strong className="block text-xs">Password protection</strong><small className="text-muted">Send the password separately</small></span>
          </label>
          {passwordProtected && (
            <label className="mt-3 grid gap-1.5 text-xs font-semibold">
              Password
              <input
                type="password"
                autoComplete="new-password"
                minLength={6}
                maxLength={128}
                value={password}
                onChange={(event) => setPassword(event.currentTarget.value)}
                placeholder="At least 6 characters"
                className="min-h-11 rounded-xl border border-line bg-background px-3 text-sm font-normal"
              />
            </label>
          )}

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-background p-3">
            <span className="flex items-center gap-2 text-xs text-muted"><ShieldCheck size={17} className="text-accent" /> 256-bit link · token never stored</span>
            <button
              type="button"
              disabled={busy !== null || (passwordProtected && password.length < 6)}
              onClick={() => void createLink()}
              className="min-h-11 rounded-xl bg-accent px-4 text-sm font-semibold text-accent-ink disabled:opacity-50"
            >{busy === "create" ? "Creating…" : "Create private link"}</button>
          </div>

          {createdToken && (
            <div className="mt-4 rounded-2xl border border-accent/40 bg-accent/8 p-4" aria-live="polite">
              <p className="text-sm font-semibold">Link ready</p>
              <p className="mt-1 text-xs leading-5 text-muted">Copy it now. Capso stores only its hash, so this exact URL cannot be shown again.</p>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(`${window.location.origin}/share#${createdToken}`);
                    setLinkCopied(true);
                  } catch {
                    setError("The private link could not be copied. Check browser clipboard permission and try again.");
                  }
                }}
                className="mt-3 min-h-11 rounded-xl border border-accent/35 bg-surface px-4 text-sm font-semibold text-accent"
              >{linkCopied ? "Copied" : "Copy private link"}</button>
            </div>
          )}

          {error && <p role="alert" className="mt-4 rounded-xl bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}

          <div className="mt-6 border-t border-line pt-5">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-sm font-semibold">Existing links</h3>
              <span className="text-xs text-muted">{links.length} of 20</span>
            </div>
            {busy === "load" ? (
              <p className="mt-3 text-xs text-muted">Loading private links…</p>
            ) : links.length === 0 ? (
              <p className="mt-3 text-xs leading-5 text-muted">No links yet. Nothing is public until you create one.</p>
            ) : (
              <ul className="mt-3 grid gap-2">
                {links.map((link) => {
                  const state = shareLinkState(link);
                  return (
                    <li key={link.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-line px-3 py-3 text-xs">
                      <span className={`h-2 w-2 rounded-full ${state === "active" ? "bg-accent" : "bg-muted"}`} aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <strong className="block text-foreground">{state === "active" ? "Active" : state.replace("_", " ")}</strong>
                        <small className="text-muted">
                          Expires {new Date(link.expiresAt).toLocaleString("en-GB")} · {link.viewCount} {link.viewCount === 1 ? "view" : "views"}
                          {link.hasPassword ? " · password" : ""}{link.oneTime ? " · one-time" : ""}
                        </small>
                      </span>
                      {state === "active" && (
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => void revoke(link.id)}
                          aria-label={`Revoke link expiring ${new Date(link.expiresAt).toLocaleString("en-GB")}`}
                          className="min-h-11 rounded-lg px-3 font-semibold text-danger disabled:opacity-50"
                        >{busy === link.id ? "Revoking…" : "Revoke"}</button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
