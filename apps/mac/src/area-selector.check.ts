import assert from "node:assert/strict";
import test from "node:test";
import {
  applyExactPixelSize,
  detectVisualRect,
  magnifierPosition,
  nudgeSelection,
  selectionFromDrag,
  selectionPixelSize,
  shouldHandleSelectionKey,
  type AreaSelection,
} from "./area-selector.ts";

const viewport = { width: 720, height: 450, scaleFactor: 2 };

test("free selection normalises a backwards drag and reports Retina output pixels", () => {
  const selection = selectionFromDrag(
    { x: 620, y: 390 },
    { x: 120, y: 90 },
    viewport,
    "free",
  );
  assert.deepEqual(selection, { x: 120, y: 90, width: 500, height: 300 });
  assert.deepEqual(selectionPixelSize(selection, viewport.scaleFactor), {
    width: 1000,
    height: 600,
  });
});

test("locked ratios remain exact and clamp to every display edge", () => {
  const selection = selectionFromDrag(
    { x: 680, y: 420 },
    { x: 100, y: 100 },
    viewport,
    "16:9",
  );
  assert.deepEqual(selection, { x: 111, y: 100, width: 569, height: 320 });
  const pixels = selectionPixelSize(selection, viewport.scaleFactor);
  assert.ok(Math.abs(pixels.width / pixels.height - 16 / 9) < 0.01);
});

test("exact pixel dimensions respect a locked ratio and stay on-screen", () => {
  const selection: AreaSelection = { x: 500, y: 310, width: 100, height: 80 };
  assert.deepEqual(
    applyExactPixelSize(selection, "width", 640, viewport, "4:3"),
    { x: 400, y: 210, width: 320, height: 240 },
  );
  assert.deepEqual(
    applyExactPixelSize(selection, "height", 1600, viewport, "4:3"),
    { x: 120, y: 0, width: 600, height: 450 },
  );
});

test("keyboard movement is in physical pixels and never leaves the display", () => {
  const selection: AreaSelection = { x: 0, y: 0, width: 300, height: 200 };
  assert.deepEqual(nudgeSelection(selection, -1, -1, viewport), selection);
  assert.deepEqual(
    nudgeSelection(selection, 20, 10, viewport),
    { x: 10, y: 5, width: 300, height: 200 },
  );
});

test("form controls keep their native arrow keys while Escape still cancels", () => {
  assert.equal(shouldHandleSelectionKey("INPUT", "ArrowRight"), false);
  assert.equal(shouldHandleSelectionKey("SELECT", "ArrowLeft"), false);
  assert.equal(shouldHandleSelectionKey("BUTTON", "Enter"), false);
  assert.equal(shouldHandleSelectionKey("INPUT", "Escape"), true);
  assert.equal(shouldHandleSelectionKey("MAIN", "ArrowRight"), true);
});

test("the magnifier flips away from display edges without covering the pointer", () => {
  const compact = { width: 800, height: 600, scaleFactor: 2 };
  assert.deepEqual(magnifierPosition({ x: 300, y: 200 }, compact), { x: 320, y: 220 });
  assert.deepEqual(magnifierPosition({ x: 790, y: 590 }, compact), { x: 650, y: 450 });
  assert.deepEqual(magnifierPosition({ x: 5, y: 590 }, compact), { x: 25, y: 450 });
});

test("visual snapping accepts one bounded high-contrast surface but rejects its background", () => {
  const width = 100;
  const height = 80;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = x >= 20 && x < 70 && y >= 15 && y < 55;
      const offset = (y * width + x) * 4;
      data[offset] = inside ? 232 : 42;
      data[offset + 1] = inside ? 232 : 42;
      data[offset + 2] = inside ? 232 : 42;
      data[offset + 3] = 255;
    }
  }
  const analysis = { width, height, data };
  const sameSizeViewport = { width, height, scaleFactor: 2 };

  assert.deepEqual(
    detectVisualRect(analysis, { x: 35, y: 30 }, sameSizeViewport),
    { x: 19, y: 14, width: 52, height: 42 },
  );
  assert.equal(detectVisualRect(analysis, { x: 5, y: 5 }, sameSizeViewport), null);

  const downscaledViewport = { width: 153, height: 121, scaleFactor: 2 };
  const downscaled = detectVisualRect(analysis, { x: 54, y: 46 }, downscaledViewport);
  assert.ok(downscaled);
  assert.ok(Object.values(downscaled).every(Number.isInteger));
});

test("visual snapping refuses text-sized islands and unbounded near-fullscreen regions", () => {
  const width = 64;
  const height = 48;
  const data = new Uint8ClampedArray(width * height * 4).fill(240);
  for (let offset = 3; offset < data.length; offset += 4) data[offset] = 255;
  const analysis = { width, height, data };
  const viewport = { width, height, scaleFactor: 1 };

  assert.equal(detectVisualRect(analysis, { x: 30, y: 20 }, viewport), null);
  for (let y = 20; y < 23; y++) {
    for (let x = 28; x < 34; x++) {
      const offset = (y * width + x) * 4;
      data[offset] = data[offset + 1] = data[offset + 2] = 20;
    }
  }
  assert.equal(detectVisualRect(analysis, { x: 30, y: 21 }, viewport), null);
});
