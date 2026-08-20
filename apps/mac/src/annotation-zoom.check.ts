import assert from "node:assert/strict";
import test from "node:test";
import {
  canvasZoomStep,
  fitCanvasSize,
  zoomedCanvasSize,
} from "./annotation-zoom.ts";

test("canvas fit never upscales small images and preserves the exact aspect ratio", () => {
  assert.deepEqual(fitCanvasSize(640, 380, 1280, 760), { width: 640, height: 380 });
  assert.deepEqual(fitCanvasSize(1000, 800, 500, 300), { width: 500, height: 300 });
  const portrait = fitCanvasSize(300, 600, 760, 1280);
  assert.equal(portrait.width, 300);
  assert.ok(Math.abs(portrait.height - (300 * 1280) / 760) < 1e-9);
  assert.deepEqual(fitCanvasSize(0, 600, 760, 1280), { width: 1, height: 1 });
});

test("zoom uses bounded predictable steps without changing intrinsic output axes", () => {
  assert.equal(canvasZoomStep(1, "in"), 1.25);
  assert.equal(canvasZoomStep(1, "out"), 0.75);
  assert.equal(canvasZoomStep(4, "in"), 4);
  assert.equal(canvasZoomStep(0.5, "out"), 0.5);
  assert.deepEqual(zoomedCanvasSize({ width: 640, height: 380 }, 2), {
    width: 1280,
    height: 760,
  });
});
