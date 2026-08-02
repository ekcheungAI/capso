import assert from "node:assert/strict";
import test from "node:test";
import {
  hitTest, isDegenerate, paintAll, pixelate, rectFrom, redacts,
  strokeFor, textSizeFor, translate, type Mark,
} from "./annotate.ts";
import { DEFAULT_COLOR as INK } from "./annotate.ts";

test("a backwards drag still produces a positive rect", () => {
  // getImageData throws on a negative width, so this is what stops the blur tool
  // breaking on every right-to-left or bottom-to-top drag.
  assert.deepEqual(rectFrom(100, 80, 20, 10), { x: 20, y: 10, w: 80, h: 70 });
  assert.deepEqual(rectFrom(20, 10, 100, 80), { x: 20, y: 10, w: 80, h: 70 });
});

test("a click that slipped is not a mark", () => {
  assert.equal(isDegenerate({ kind: "box", color: INK, x: 0, y: 0, w: 2, h: 40 }), true);
  assert.equal(isDegenerate({ kind: "blur", x: 0, y: 0, w: 40, h: 2 }), true);
  assert.equal(isDegenerate({ kind: "arrow", color: INK, x1: 0, y1: 0, x2: 3, y2: 3 }), true);
  assert.equal(isDegenerate({ kind: "text", color: INK, x: 0, y: 0, text: "   ", size: 20 }), true);
});

test("a mark with non-finite coordinates is rejected", () => {
  // A canvas with no layout size makes the screen-to-image conversion divide by
  // zero. Every size comparison against NaN is false, so before this guard such
  // a mark passed the check, was committed, and then painted nothing — the
  // editor silently swallowed the drag.
  assert.equal(isDegenerate({ kind: "arrow", color: INK, x1: NaN, y1: NaN, x2: NaN, y2: NaN }), true);
  assert.equal(isDegenerate({ kind: "box", color: INK, x: NaN, y: 0, w: 90, h: 90 }), true);
  assert.equal(isDegenerate({ kind: "blur", x: 0, y: 0, w: Infinity, h: 90 }), true);
  assert.equal(isDegenerate({ kind: "text", color: INK, x: NaN, y: 0, text: "hi", size: 20 }), true);
});

test("a deliberate mark survives", () => {
  assert.equal(isDegenerate({ kind: "box", color: INK, x: 0, y: 0, w: 60, h: 40 }), false);
  assert.equal(isDegenerate({ kind: "arrow", color: INK, x1: 0, y1: 0, x2: 90, y2: 40 }), false);
  assert.equal(isDegenerate({ kind: "text", color: INK, x: 0, y: 0, text: "look", size: 20 }), false);
});

test("stroke and text scale with the image, with a floor for small ones", () => {
  assert.ok(strokeFor(1600) > strokeFor(600));
  assert.ok(textSizeFor(1600) > textSizeFor(600));
  assert.equal(strokeFor(50), 2);
  assert.equal(textSizeFor(50), 14);
});

/** Records the order of operations without needing a real canvas. */
function fakeCtx() {
  const ops: string[] = [];
  return {
    ops,
    ctx: {
      ops,
      strokeStyle: "", fillStyle: "", lineWidth: 0, lineCap: "", lineJoin: "", font: "", textBaseline: "",
      strokeRect: () => ops.push("box"),
      fillRect: () => ops.push("blurblock"),
      strokeText: () => {}, fillText: () => ops.push("text"),
      beginPath: () => {}, moveTo: () => {}, lineTo: () => {}, closePath: () => {},
      stroke: () => ops.push("arrowshaft"), fill: () => ops.push("arrowhead"),
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(Math.max(1, w * h * 4)),
      }),
    } as unknown as CanvasRenderingContext2D,
  };
}

test("blurs are painted before anything else", () => {
  // Pixelation samples what is already on the canvas. A blur painted last would
  // smear the arrow into the region and swallow a label drawn over it.
  const marks: Mark[] = [
    { kind: "arrow", color: INK, x1: 0, y1: 0, x2: 90, y2: 40 },
    { kind: "blur", x: 0, y: 0, w: 40, h: 40 },
    { kind: "box", color: INK, x: 0, y: 0, w: 60, h: 40 },
  ];
  const { ops, ctx } = fakeCtx();
  paintAll(ctx, marks, 800);
  assert.ok(ops.indexOf("blurblock") < ops.indexOf("arrowshaft"), `order was ${ops.join(",")}`);
  assert.ok(ops.indexOf("blurblock") < ops.indexOf("box"), `order was ${ops.join(",")}`);
});

test("pixelate covers the whole region it was given", () => {
  const { ops, ctx } = fakeCtx();
  pixelate(ctx, 0, 0, 48, 48, 12);
  // 4x4 blocks at a 12px block size, every one filled.
  assert.equal(ops.filter((o) => o === "blurblock").length, 16);
});

test("pixelate on a degenerate region does nothing rather than throwing", () => {
  const { ops, ctx } = fakeCtx();
  pixelate(ctx, 0, 0, 0, 0);
  assert.deepEqual(ops, []);
});

// ------------------------------------------------------ select and move ----

test("a point inside a mark hits it, a point outside does not", () => {
  const marks: Mark[] = [{ kind: "box", color: INK, x: 100, y: 100, w: 200, h: 80 }];
  assert.equal(hitTest(marks, 150, 130, 900), 0);
  assert.equal(hitTest(marks, 500, 130, 900), null);
});

test("clicking where two marks overlap grabs the one painted on top", () => {
  const marks: Mark[] = [
    { kind: "box", color: INK, x: 0, y: 0, w: 300, h: 300 },
    { kind: "box", color: INK, x: 100, y: 100, w: 100, h: 100 },
  ];
  assert.equal(hitTest(marks, 150, 150, 900), 1);
});

test("an arrow is hit anywhere in the box its two ends span", () => {
  const marks: Mark[] = [{ kind: "arrow", color: INK, x1: 100, y1: 100, x2: 300, y2: 200 }];
  assert.equal(hitTest(marks, 200, 150, 900), 0);
  assert.equal(hitTest(marks, 600, 150, 900), null);
});

test("an arrow drawn backwards is still hittable", () => {
  // Its x1,y1 is below-right of x2,y2, so an unnormalised bounds check would
  // produce a negative-size rect that contains nothing.
  const marks: Mark[] = [{ kind: "arrow", color: INK, x1: 300, y1: 200, x2: 100, y2: 100 }];
  assert.equal(hitTest(marks, 200, 150, 900), 0);
});

test("moving a mark shifts every coordinate it owns", () => {
  const moved = translate({ kind: "arrow", color: INK, x1: 10, y1: 20, x2: 30, y2: 40 }, 5, -5);
  assert.deepEqual(moved, { kind: "arrow", color: INK, x1: 15, y1: 15, x2: 35, y2: 35 });
  assert.deepEqual(
    translate({ kind: "blur", x: 10, y: 20, w: 100, h: 50 }, -10, 10),
    { kind: "blur", x: 0, y: 30, w: 100, h: 50 },
  );
});

test("moving does not resize", () => {
  const before: Mark = { kind: "box", color: INK, x: 10, y: 10, w: 120, h: 60 };
  const after = translate(before, 40, 40) as Extract<Mark, { kind: "box" }>;
  assert.equal(after.w, 120);
  assert.equal(after.h, 60);
});

test("only blur counts as redaction, because only blur destroys pixels", () => {
  assert.equal(redacts([{ kind: "box", color: INK, x: 0, y: 0, w: 10, h: 10 }]), false);
  assert.equal(redacts([{ kind: "blur", x: 0, y: 0, w: 10, h: 10 }]), true);
});
