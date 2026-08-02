#!/usr/bin/env node
/**
 * Mirror the capture spec into the Chrome extension.
 *
 *     pnpm capture:spec          write the generated file
 *     pnpm capture:check         verify it is current
 *
 * The extension ships as a plain zip with no bundler, so it cannot import
 * `@capso/shared`. Before this, that meant `MAX_EDGE` and the JPEG quality were
 * declared independently in `apps/extension/capture.js` and
 * `apps/web/components/capture.tsx`, held together only by a comment claiming
 * they matched. The Mac app (M1) would have been a third copy.
 *
 * Same reasoning as `gen-tokens.mjs`, and the same failure it was written to
 * stop: without a mechanism, drift is the default state rather than a mistake.
 *
 * Constants come from the TypeScript source itself, so there is exactly one
 * place to change them. The two pure functions are re-emitted here in JS; a
 * check in `packages/shared/src/capture.check.ts` runs both implementations over
 * the same inputs so a divergence fails the test run rather than shipping.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "apps/extension/capture-spec.generated.js");

const {
  MAX_EDGE, FULL_QUALITY, FULL_TYPE,
  THUMB_EDGE, THUMB_QUALITY, THUMB_TYPE,
} = await import(join(ROOT, "packages/shared/src/capture.ts"));

const body = `/* GENERATED — DO NOT EDIT.
   Source: packages/shared/src/capture.ts
   Regenerate: pnpm capture:spec   ·   Verify: pnpm capture:check

   The extension has no bundler, so the shared capture spec is mirrored here.
   Editing this file by hand reintroduces exactly the drift it exists to stop. */

/** Long edge of the stored original. */
export const MAX_EDGE = ${MAX_EDGE};
export const FULL_QUALITY = ${FULL_QUALITY};
export const FULL_TYPE = ${JSON.stringify(FULL_TYPE)};

/** Thumb spec — 14_BACKEND_AND_STORAGE.md §1. */
export const THUMB_EDGE = ${THUMB_EDGE};
export const THUMB_QUALITY = ${THUMB_QUALITY};
export const THUMB_TYPE = ${JSON.stringify(THUMB_TYPE)};

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
`;

const check = process.argv.includes("--check");
const current = (() => {
  try {
    return readFileSync(OUT, "utf8");
  } catch {
    return null;
  }
})();

if (check) {
  if (current !== body) {
    console.error(
      "capture spec is stale: apps/extension/capture-spec.generated.js does not match\n" +
        "packages/shared/src/capture.ts. Run `pnpm capture:spec`.",
    );
    process.exit(1);
  }
  console.log("capture spec check passed");
} else if (current === body) {
  console.log("capture spec already current");
} else {
  writeFileSync(OUT, body);
  console.log("capture-spec.generated.js → apps/extension/");
}
