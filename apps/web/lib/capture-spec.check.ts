import assert from "node:assert/strict";
import test from "node:test";
import * as shared from "@capso/shared/capture";
// The mirror the extension actually loads. Imported from its real path rather
// than regenerated here — a check that reads its own output proves nothing.
import * as mirror from "../../extension/capture-spec.generated.js";

/**
 * The extension ships unbundled, so the capture spec exists twice: once in
 * TypeScript for the web app and the Mac app, once as generated JavaScript for
 * the extension. `pnpm capture:check` proves the *file* is current; this proves
 * the two implementations actually behave the same.
 *
 * That distinction matters. A stale file is caught by a byte comparison, but a
 * generator that emits subtly different arithmetic would pass that check and
 * still make two surfaces disagree about the size of the same screenshot.
 */

test("the mirror carries the same constants as the spec", () => {
  for (const k of [
    "MAX_EDGE", "FULL_QUALITY", "FULL_TYPE",
    "THUMB_EDGE", "THUMB_QUALITY", "THUMB_TYPE",
  ] as const) {
    assert.equal(mirror[k], shared[k], `${k} differs between the spec and the extension mirror`);
  }
});

test("fitWithin agrees to the pixel across shapes, scales and the no-upscale case", () => {
  const sizes: [number, number][] = [
    [3024, 1964], // MacBook retina, the common Mac-app case
    [1280, 800],
    [400, 300],   // already under the cap — must not scale up
    [1, 1],
    [4000, 10],   // extreme landscape
    [10, 4000],   // extreme portrait
    [1600, 1600], // exactly at the cap
    [1601, 1601], // one over
  ];
  for (const [w, h] of sizes) {
    for (const edge of [shared.MAX_EDGE, shared.THUMB_EDGE]) {
      assert.deepEqual(
        mirror.fitWithin(w, h, edge),
        shared.fitWithin(w, h, edge),
        `fitWithin(${w}, ${h}, ${edge}) differs`,
      );
    }
  }
});

test("fitWithin never scales up", () => {
  assert.deepEqual(shared.fitWithin(400, 300), { width: 400, height: 300 });
});

test("aspectOf agrees, including either side of both thresholds", () => {
  const ratios: [number, number][] = [
    [1200, 1000], // 1.2 exactly — boundary, must not be "wide"
    [1201, 1000],
    [850, 1000],  // 0.85 exactly — boundary, must not be "tall"
    [849, 1000],
    [1600, 900], [900, 1600], [1000, 1000],
  ];
  for (const [w, h] of ratios) {
    assert.equal(mirror.aspectOf(w, h), shared.aspectOf(w, h), `aspectOf(${w}, ${h}) differs`);
  }
});

test("contentHash agrees, so a duplicate captured on two surfaces is one capsule", async () => {
  const sample = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA==";
  const [a, b] = await Promise.all([shared.contentHash(sample), mirror.contentHash(sample)]);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/, "expected a SHA-256 hex digest");
});
