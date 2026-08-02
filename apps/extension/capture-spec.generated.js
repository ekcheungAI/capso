/* GENERATED — DO NOT EDIT.
   Source: packages/shared/src/capture.ts
   Regenerate: pnpm capture:spec   ·   Verify: pnpm capture:check

   The extension has no bundler, so the shared capture spec is mirrored here.
   Editing this file by hand reintroduces exactly the drift it exists to stop. */

/** Long edge of the stored original. */
export const MAX_EDGE = 1600;
export const FULL_QUALITY = 0.85;
export const FULL_TYPE = "image/jpeg";

/** Thumb spec — 14_BACKEND_AND_STORAGE.md §1. */
export const THUMB_EDGE = 800;
export const THUMB_QUALITY = 0.8;
export const THUMB_TYPE = "image/webp";

/** Fit inside a long-edge cap, never scaling up. Must agree to the pixel. */
export function fitWithin(width, height, maxEdge = MAX_EDGE) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Layout bucket. Same thresholds the row mapper uses when reading back. */
export function aspectOf(width, height) {
  const ratio = width / height;
  return ratio > 1.2 ? "wide" : ratio < 0.85 ? "tall" : "square";
}

/**
 * Fingerprint of the *stored* bytes, for exact-duplicate detection at ingest.
 * Hash what you actually store — a hash taken before a later re-encode
 * describes something that no longer exists.
 */
export async function contentHash(encodedDataUrl) {
  const bytes = new TextEncoder().encode(encodedDataUrl);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
