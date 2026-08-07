import { z } from "zod";

/**
 * One definition of what a capture *is*, for every surface that can make one.
 *
 * There are three such surfaces and soon a fourth: the Chrome extension, the web
 * app's drag/paste path, the sample generator, and the Mac app (M1). Until now
 * each carried its own copy of the numbers below — `MAX_EDGE` was declared
 * independently in `apps/extension/capture.js` and `apps/web/components/capture.tsx`,
 * with a comment in one saying it "matches the web app's own ingest cap". A
 * comment is not a mechanism, and the Mac app would have made a third copy.
 *
 * The rule this file exists to enforce: **two surfaces capturing the same screen
 * must produce the same stored artefact.** Same pixel dimensions, same encoding,
 * same aspect bucket, same content hash. Anything less and dedupe misfires,
 * thumbnails differ in size between a browser capture and a desktop one, and the
 * classifier sees systematically different inputs depending on where the user
 * happened to press the hotkey.
 *
 * The extension cannot import this module — it ships as a plain zip with no
 * bundler — so `scripts/gen-capture-spec.mjs` generates a JavaScript mirror into
 * `apps/extension/`, exactly as `gen-tokens.mjs` does for brand tokens, and
 * `pnpm lint` fails if the mirror has drifted.
 */

// ------------------------------------------------------------- encoding ----

/**
 * Long edge of the stored original.
 *
 * Two independent ceilings meet here. `chrome.tabs.captureVisibleTab` returns an
 * uncompressed retina PNG — measured ~4.2 MB, ~5.6 MB base64 — which is over
 * Vercel's 4.5 MB request-body limit, so the extension has to shrink before the
 * wire. And 09 §1 caps what goes to the vision model to control image tokens.
 * 1600 satisfies both and still reads small type in a screenshot.
 */
export const MAX_EDGE = 1600;
export const FULL_QUALITY = 0.85;
export const FULL_TYPE = "image/jpeg";

/** Thumb spec — 14_BACKEND_AND_STORAGE.md §1: WebP, 800 px long edge, quality ~80. */
export const THUMB_EDGE = 800;
export const THUMB_QUALITY = 0.8;
export const THUMB_TYPE = "image/webp";

/**
 * Fit a bitmap inside a long-edge cap, never scaling up.
 *
 * Shared because the arithmetic has to agree to the pixel: `width`/`height` are
 * stored on the row and used to reserve layout before the image decodes, and
 * they are what `aspectOf` buckets. A Mac capture and a browser capture of the
 * same screen that disagreed by one rounded pixel would sort into different
 * aspect buckets at the boundary and reflow the grid differently.
 */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number = MAX_EDGE,
): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Which of the three layout buckets a capture falls into.
 *
 * Was written out three times — in the web capture path, and again in the store's
 * row mapper, which meant a capture could be bucketed one way when captured and
 * another way when re-read from the database.
 */
export function aspectOf(width: number, height: number): "tall" | "wide" | "square" {
  const ratio = width / height;
  return ratio > 1.2 ? "wide" : ratio < 0.85 ? "tall" : "square";
}

// ----------------------------------------------------------------- hash ----

/**
 * Stable fingerprint of a capture, for exact-duplicate detection at ingest
 * (10 §screenshots.content_hash).
 *
 * Hashed over the *encoded* data URL, after downscaling, on purpose: two grabs of
 * the same unchanged screen produce identical compressed output, whereas raw
 * screenshots differ by a cursor pixel or a clock digit and would never match.
 *
 * The corollary is a rule every surface must follow — **hash the bytes you
 * actually store.** Hashing before a later re-encode produces a fingerprint of
 * something that no longer exists, which is precisely the state the extension
 * path is in today: it hashes its own compressed output, the web app re-encodes
 * on receipt, and the stored bytes no longer match the hash.
 *
 * `crypto.subtle` exists in browsers, MV3 service workers, Node 18+ and Deno, so
 * one implementation covers every surface including the Edge worker.
 */
export async function contentHash(encodedDataUrl: string): Promise<string> {
  const bytes = new TextEncoder().encode(encodedDataUrl);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// -------------------------------------------------------------- sources ----

/**
 * Where a capture came from. Mirrors `Screenshot["source"]`.
 *
 * `hotkey_region`, `hotkey_window`, and `hotkey_fullscreen` are the Mac app's
 * capture modes (D15); they exist here already because the sample generator
 * uses the first, and because a surface that invents its own source string ends
 * up invisible to the provenance badge.
 */
export const captureSource = z.enum([
  "hotkey_region",
  "hotkey_window",
  "hotkey_fullscreen",
  "drag",
  "clipboard",
  "web_upload",
  "extension",
  "seed",
]);
export type CaptureSource = z.infer<typeof captureSource>;

// ------------------------------------------------------------- transport ----

/** Raster only — `data:image/svg+xml` is markup, not a screenshot, and can carry a script. */
export const IMAGE_DATA_URL = /^data:image\/(png|jpe?g|webp);base64,/i;

/** Opaque, client-generated, echoed in URLs and logs — keep it boring. */
export const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * What any surface sends to hand Capso a capture.
 *
 * Currently only the extension posts this (to `/api/ingest`), and the route
 * re-declares the same fields by hand. Declaring it once means the Mac app
 * cannot quietly send a differently-shaped payload, and the route's validation
 * and the client's construction cannot drift apart.
 *
 * `id` is generated by the *client*, not the server: a retry must carry the same
 * id or it becomes a second capsule, which is the bug that made every lost
 * response duplicate a capture.
 */
export const ingestPayload = z.object({
  id: z.string().regex(OPAQUE_TOKEN),
  /** Which install this capture belongs to. Set at pairing time. */
  deviceToken: z.string().regex(OPAQUE_TOKEN),
  imageDataUrl: z.string().regex(IMAGE_DATA_URL),
  source: captureSource,
  /** Present for browser captures; the Mac app sends `sourceApp` instead. */
  pageUrl: z.string().max(2048).optional(),
  pageTitle: z.string().max(512).optional(),
  /** Frontmost app, or the host a browser capture came from. */
  sourceApp: z.string().max(128).optional(),
  /** True pixel size of the *stored* image, after `fitWithin`. */
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  /** Over the stored bytes — see `contentHash`. */
  contentHash: z.string().max(128).optional(),
});
export type IngestPayload = z.infer<typeof ingestPayload>;
