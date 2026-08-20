import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  appendFreehandPoint,
  arrowCurveControl,
  blurRegion,
  blurStrengthParameters,
  boundsOf,
  closestSizePreset,
  cropFromDrag,
  cropFromDragWithAspect,
  detectSmartHighlightBand,
  eraseFreehandMarks,
  eraserRadiusFor,
  fitTextWithinCanvas,
  hitResizeHandle,
  highlighterOpacityFor,
  highlighterStrokeFor,
  imageDeltaFromOutput,
  imageScaleForOutputDimension,
  imageScaleOutputSize,
  imagePointFromOutput,
  imagePointToOutput,
  imageTransformMatrix,
  imageTransformOutputSize,
  isValidImageScale,
  isDegenerate,
  isDegenerateCrop,
  nextCounterValue,
  paint,
  paintAll,
  paintSelection,
  pixelate,
  axisLockedDelta,
  rectFromSquareDrag,
  resizeHandles,
  resizeMark,
  redacts,
  sizeForPreset,
  updateImageTransform,
  spotlightOpacityFor,
  strokeFor,
  translate,
  type AnnotationCanvasContext,
  type Mark,
} from "./annotate.ts";

type RedactionFixture = {
  width: number;
  height: number;
  redaction: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  originalRgba: number[];
  flattenedRgba: number[];
};

const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/annotation-redaction.json", import.meta.url),
    "utf8",
  ),
) as RedactionFixture;

class MemoryCanvas implements AnnotationCanvasContext {
  readonly canvas: { width: number; height: number };
  strokeStyle: string | object = "";
  fillStyle: string | object = "";
  lineWidth = 0;
  lineCap = "";
  lineJoin = "";
  font = "";
  textBaseline = "";
  textAlign = "";
  lineDashOffset = 0;
  globalAlpha = 1;
  private readonly width: number;
  private readonly pixels: Uint8ClampedArray;
  readonly ellipses: number[][] = [];
  readonly lineSegments: number[][] = [];
  readonly quadraticCurves: number[][] = [];
  readonly fillAlphas: number[] = [];
  readonly strokeWidths: number[] = [];
  readonly strokeAlphas: number[] = [];
  readonly arcs: number[][] = [];
  readonly labels: Array<[string, number, number]> = [];
  readonly labelFonts: string[] = [];
  readonly filledRects: number[][] = [];
  readonly filledRectStyles: string[] = [];
  readonly strokedRects: number[][] = [];
  readonly strokedLabels: string[] = [];
  readonly overlayRects: number[][] = [];
  readonly overlayStyles: string[] = [];
  readonly operations: string[] = [];
  readonly fillRules: Array<"nonzero" | "evenodd" | undefined> = [];
  private readonly alphaStack: number[] = [];
  private pathStart: [number, number] | null = null;

  constructor(width: number, pixels: Uint8ClampedArray) {
    this.width = width;
    this.pixels = pixels;
    this.canvas = { width, height: pixels.length / 4 / width };
  }

  get rgba() {
    return [...this.pixels];
  }

  getImageData(x: number, y: number, width: number, height: number) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const source = ((y + row) * this.width + x + column) * 4;
        const target = (row * width + column) * 4;
        data.set(this.pixels.subarray(source, source + 4), target);
      }
    }
    return { data, width, height };
  }

  putImageData(image: { data: Uint8ClampedArray; width: number; height: number }, x: number, y: number) {
    for (let row = 0; row < image.height; row += 1) {
      for (let column = 0; column < image.width; column += 1) {
        const source = (row * image.width + column) * 4;
        const target = ((y + row) * this.width + x + column) * 4;
        this.pixels.set(image.data.subarray(source, source + 4), target);
      }
    }
  }

  fillRect(x: number, y: number, width: number, height: number) {
    assert.equal(typeof this.fillStyle, "string");
    const match = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(this.fillStyle as string);
    if (!match) {
      if (/^rgba\(0,0,0,/.test(this.fillStyle as string)) {
        this.overlayRects.push([x, y, width, height]);
        this.overlayStyles.push(this.fillStyle as string);
        this.operations.push("spotlight");
      } else {
        this.filledRects.push([x, y, width, height]);
        this.filledRectStyles.push(this.fillStyle as string);
      }
      return;
    }
    const color = match.slice(1).map(Number);
    for (let row = y; row < y + height; row += 1) {
      for (let column = x; column < x + width; column += 1) {
        const offset = (row * this.width + column) * 4;
        this.pixels.set([...color, 255], offset);
      }
    }
  }

  strokeRect(x: number, y: number, width: number, height: number) {
    this.strokedRects.push([x, y, width, height]);
  }
  strokeText(text: string) { this.strokedLabels.push(text); }
  fillText(text: string, x: number, y: number) {
    this.labels.push([text, x, y]);
    this.labelFonts.push(this.font);
  }
  beginPath() {}
  moveTo(x: number, y: number) { this.pathStart = [x, y]; }
  lineTo(x: number, y: number) {
    if (this.pathStart) {
      this.lineSegments.push([...this.pathStart, x, y]);
      this.operations.push("line");
    }
  }
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number) {
    this.quadraticCurves.push([cpx, cpy, x, y]);
  }
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number) {
    this.arcs.push([x, y, radius, startAngle, endAngle]);
  }
  ellipse(x: number, y: number, radiusX: number, radiusY: number, rotation: number, startAngle: number, endAngle: number) {
    this.ellipses.push([x, y, radiusX, radiusY, rotation, startAngle, endAngle]);
  }
  closePath() {}
  stroke() {
    this.strokeWidths.push(this.lineWidth);
    this.strokeAlphas.push(this.globalAlpha);
  }
  fill(fillRule?: "nonzero" | "evenodd") {
    this.fillAlphas.push(this.globalAlpha);
    this.fillRules.push(fillRule);
  }
  setLineDash() {}
  save() { this.alphaStack.push(this.globalAlpha); }
  restore() { this.globalAlpha = this.alphaStack.pop() ?? 1; }
}

const rgbValues = (rgba: number[]) => rgba.filter((_, index) => index % 4 === 0);

test("the production pixelator irreversibly produces the shared native redaction fixture", () => {
  assert.equal(fixture.originalRgba.length, fixture.width * fixture.height * 4);
  assert.equal(fixture.flattenedRgba.length, fixture.originalRgba.length);
  const canvas = new MemoryCanvas(
    fixture.width,
    Uint8ClampedArray.from(fixture.originalRgba),
  );

  pixelate(
    canvas,
    fixture.redaction.x,
    fixture.redaction.y,
    fixture.redaction.width,
    fixture.redaction.height,
  );

  assert.deepEqual(canvas.rgba, fixture.flattenedRgba);
  const originalDetails = new Set(rgbValues(fixture.originalRgba));
  const flattenedDetails = new Set(rgbValues(canvas.rgba));
  assert.ok(flattenedDetails.size < originalDetails.size);
  for (const detail of originalDetails) {
    assert.equal(
      flattenedDetails.has(detail),
      false,
      `source detail ${detail} survived redaction`,
    );
  }
});

test("secure and smooth blur are deterministic but only secure blur is a redaction", () => {
  const width = 32;
  const height = 16;
  const source = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    source[index * 4] = (index * 17) % 251;
    source[index * 4 + 1] = (index * 29) % 253;
    source[index * 4 + 2] = (index * 43) % 247;
    source[index * 4 + 3] = 255;
  }

  const smooth = new MemoryCanvas(width, source.slice());
  const secure = new MemoryCanvas(width, source.slice());
  const secureReplay = new MemoryCanvas(width, source.slice());
  blurRegion(smooth, 0, 0, width, height, "smooth");
  blurRegion(secure, 0, 0, width, height, "secure");
  blurRegion(secureReplay, 0, 0, width, height, "secure");

  assert.deepEqual(secure.rgba, secureReplay.rgba, "editable replay must remain byte-stable");
  assert.notDeepEqual(smooth.rgba, [...source]);
  assert.notDeepEqual(secure.rgba, [...source]);
  assert.ok(new Set(rgbValues(secure.rgba)).size < new Set(rgbValues(smooth.rgba)).size);
  assert.equal(redacts([{ kind: "blur_effect", x: 0, y: 0, w: width, h: height, blurMode: "secure" }]), true);
  assert.equal(redacts([{ kind: "blur_effect", x: 0, y: 0, w: width, h: height, blurMode: "smooth" }]), false);
  assert.equal(redacts([{ kind: "blur", x: 0, y: 0, w: width, h: height }]), true);
});

test("blur intensity presets are ordered, deterministic and keep every secure preset destructive", () => {
  const strengths = ["soft", "regular", "strong"] as const;
  assert.deepEqual(
    strengths.map((strength) => blurStrengthParameters(96, 48, strength)),
    [
      { secureBlock: 12, smoothRadius: 4 },
      { secureBlock: 16, smoothRadius: 6 },
      { secureBlock: 22, smoothRadius: 9 },
    ],
  );

  const width = 96;
  const height = 48;
  const source = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    source[index * 4] = (index * 17) % 251;
    source[index * 4 + 1] = (index * 29) % 253;
    source[index * 4 + 2] = (index * 43) % 247;
    source[index * 4 + 3] = 255;
  }

  const outputs = strengths.map((strength) => {
    const first = new MemoryCanvas(width, source.slice());
    const replay = new MemoryCanvas(width, source.slice());
    blurRegion(first, 0, 0, width, height, "secure", strength);
    blurRegion(replay, 0, 0, width, height, "secure", strength);
    assert.deepEqual(first.rgba, replay.rgba);
    assert.notDeepEqual(first.rgba, [...source]);
    return first.rgba;
  });
  assert.notDeepEqual(outputs[0], outputs[1]);
  assert.notDeepEqual(outputs[1], outputs[2]);
});

test("line and ellipse share exact geometry, selection movement and canvas output", () => {
  const line: Mark = { kind: "line", color: "currentColor", x1: 10, y1: 20, x2: 70, y2: 80 };
  const ellipse: Mark = { kind: "ellipse", color: "currentColor", x: 20, y: 30, w: 80, h: 40, filled: true };
  assert.equal(isDegenerate(line), false);
  assert.equal(isDegenerate({ ...line, x2: 12, y2: 21 }), true);
  assert.equal(isDegenerate(ellipse), false);
  assert.equal(isDegenerate({ ...ellipse, h: 2 }), true);
  assert.deepEqual(translate(line, 5, -3), { ...line, x1: 15, y1: 17, x2: 75, y2: 77 });
  assert.deepEqual(translate(ellipse, 5, -3), { ...ellipse, x: 25, y: 27 });

  const canvas = new MemoryCanvas(160, new Uint8ClampedArray(160 * 120 * 4));
  paint(canvas, line, 160);
  paint(canvas, ellipse, 160);
  assert.deepEqual(canvas.lineSegments, [[10, 20, 70, 80]]);
  assert.equal(canvas.ellipses.length, 1);
  assert.deepEqual(canvas.ellipses[0]?.slice(0, 4), [60, 50, 40, 20]);
  assert.deepEqual(canvas.fillAlphas, [0.18]);
  assert.equal(canvas.globalAlpha, 1);
});

test("stroke variants scale with the image and expand selection bounds", () => {
  const thin: Mark = {
    kind: "line",
    color: "currentColor",
    strokeWeight: "thin",
    x1: 10,
    y1: 20,
    x2: 70,
    y2: 80,
  };
  const bold: Mark = { ...thin, strokeWeight: "bold" };
  assert.equal(strokeFor(960), 3, "regular output must preserve the original width");
  assert.equal(strokeFor(960, "thin"), 2);
  assert.equal(strokeFor(960, "bold"), 5);
  assert.ok(boundsOf(bold, 960).w > boundsOf(thin, 960).w);

  const canvas = new MemoryCanvas(960, new Uint8ClampedArray(960 * 100 * 4));
  paint(canvas, thin, 960);
  paint(canvas, bold, 960);
  assert.deepEqual(canvas.strokeWidths, [2, 5]);
});

test("four arrow styles retain endpoints while painting distinct real geometry", () => {
  const base: Extract<Mark, { kind: "arrow" }> = {
    kind: "arrow",
    color: "currentColor",
    x1: 20,
    y1: 80,
    x2: 140,
    y2: 80,
  };
  const classic = new MemoryCanvas(160, new Uint8ClampedArray(160 * 120 * 4));
  const open = new MemoryCanvas(160, new Uint8ClampedArray(160 * 120 * 4));
  const curved = new MemoryCanvas(160, new Uint8ClampedArray(160 * 120 * 4));
  const double = new MemoryCanvas(160, new Uint8ClampedArray(160 * 120 * 4));

  paint(classic, { ...base, arrowStyle: "classic" }, 160);
  paint(open, { ...base, arrowStyle: "open" }, 160);
  paint(curved, { ...base, arrowStyle: "curved" }, 160);
  paint(double, { ...base, arrowStyle: "double" }, 160);

  assert.equal(classic.fillAlphas.length, 1, "classic keeps the filled head");
  assert.equal(open.fillAlphas.length, 0, "open uses two stroked head arms");
  assert.equal(curved.quadraticCurves.length, 1, "curved is a quadratic path, not a visual label");
  assert.equal(curved.fillAlphas.length, 1);
  assert.equal(double.fillAlphas.length, 2, "double paints one head at each endpoint");
  assert.deepEqual(arrowCurveControl(base), { x: 80, y: 46.4 });
  assert.ok(boundsOf({ ...base, arrowStyle: "curved" }, 160).y < boundsOf(base, 160).y);
  assert.deepEqual(
    resizeMark({ ...base, arrowStyle: "curved" }, "end", 150, 60),
    { ...base, x2: 150, y2: 60, arrowStyle: "curved" },
  );
});

test("seven text presets paint distinct fonts and backing geometry", () => {
  const base: Extract<Mark, { kind: "text" }> = {
    kind: "text",
    color: "currentColor",
    x: 30,
    y: 40,
    text: "Review",
    size: 20,
  };
  const standard = new MemoryCanvas(240, new Uint8ClampedArray(240 * 120 * 4));
  const rounded = new MemoryCanvas(240, new Uint8ClampedArray(240 * 120 * 4));
  const monospaced = new MemoryCanvas(240, new Uint8ClampedArray(240 * 120 * 4));
  const outlined = new MemoryCanvas(240, new Uint8ClampedArray(240 * 120 * 4));
  const boxed = new MemoryCanvas(240, new Uint8ClampedArray(240 * 120 * 4));
  const roundedBoxed = new MemoryCanvas(240, new Uint8ClampedArray(240 * 120 * 4));
  const monospacedBoxed = new MemoryCanvas(240, new Uint8ClampedArray(240 * 120 * 4));

  paint(standard, { ...base, textStyle: "standard" }, 240);
  paint(rounded, { ...base, textStyle: "rounded" }, 240);
  paint(monospaced, { ...base, textStyle: "monospaced" }, 240);
  paint(outlined, { ...base, textStyle: "outlined" }, 240);
  paint(boxed, { ...base, textStyle: "boxed" }, 240);
  paint(roundedBoxed, { ...base, textStyle: "rounded-boxed" }, 240);
  paint(monospacedBoxed, { ...base, textStyle: "monospaced-boxed" }, 240);

  assert.match(standard.labelFonts[0]!, /^600 20px ui-sans-serif/);
  assert.match(rounded.labelFonts[0]!, /ui-rounded/);
  assert.match(monospaced.labelFonts[0]!, /ui-monospace/);
  assert.deepEqual(outlined.strokedLabels, ["Review"]);
  assert.equal(boxed.filledRects.length, 1);
  assert.equal(roundedBoxed.quadraticCurves.length, 4);
  assert.equal(monospacedBoxed.filledRects.length, 1);
  assert.equal(monospacedBoxed.strokedRects.length, 1);
  assert.ok(boundsOf({ ...base, textStyle: "boxed" }, 240).w > boundsOf(base, 240).w);
  const fittedRight = fitTextWithinCanvas(
    { ...base, x: 220, textStyle: "monospaced-boxed" },
    240,
    120,
  );
  assert.ok(Math.abs(fittedRight.x - 158.4) < Number.EPSILON * 240);
  assert.deepEqual(fittedRight, { ...base, x: fittedRight.x, textStyle: "monospaced-boxed" });
  assert.deepEqual(
    fitTextWithinCanvas({ ...base, x: -10, y: 115 }, 240, 120),
    { ...base, x: 0, y: 100 },
  );
});

test("counters keep a stable number, geometry and flattened label", () => {
  const counter: Mark = {
    kind: "counter",
    color: "currentColor",
    x: 40,
    y: 50,
    value: 3,
    size: 32,
  };
  assert.equal(isDegenerate(counter), false);
  assert.equal(isDegenerate({ ...counter, value: 0 }), false);
  assert.equal(isDegenerate({ ...counter, value: -1 }), true);
  assert.deepEqual(translate(counter, 5, -3), { ...counter, x: 45, y: 47 });

  const canvas = new MemoryCanvas(160, new Uint8ClampedArray(160 * 120 * 4));
  paint(canvas, counter, 160);
  assert.deepEqual(canvas.arcs, [[40, 50, 16, 0, Math.PI * 2]]);
  assert.deepEqual(canvas.labels, [["3", 40, 50]]);
  assert.equal(nextCounterValue([counter, { ...counter, value: 7 }]), 8);
  assert.equal(nextCounterValue([]), 1);
  assert.equal(nextCounterValue([], 0), 0);
  assert.equal(nextCounterValue([counter], 10), 10);
  assert.equal(sizeForPreset(40, "small"), 31);
  assert.equal(sizeForPreset(40, "regular"), 40);
  assert.equal(sizeForPreset(40, "large"), 52);
  assert.equal(closestSizePreset(51, 40), "large");
});

test("counter styles paint distinct filled, outlined and number-only marks", () => {
  const base: Mark = {
    kind: "counter",
    color: "currentColor",
    x: 40,
    y: 50,
    value: 8,
    size: 32,
  };
  const filled = new MemoryCanvas(160, new Uint8ClampedArray(160 * 120 * 4));
  const outlined = new MemoryCanvas(160, new Uint8ClampedArray(160 * 120 * 4));
  const plain = new MemoryCanvas(160, new Uint8ClampedArray(160 * 120 * 4));

  paint(filled, { ...base, counterStyle: "filled" }, 160);
  paint(outlined, { ...base, counterStyle: "outlined" }, 160);
  paint(plain, { ...base, counterStyle: "plain" }, 160);

  assert.equal(filled.arcs.length, 1);
  assert.equal(filled.fillAlphas.length, 1);
  assert.equal(outlined.arcs.length, 1);
  assert.equal(outlined.fillAlphas.length, 0);
  assert.ok(outlined.strokeWidths.length > 0);
  assert.equal(plain.arcs.length, 0);
  assert.deepEqual(plain.strokedLabels, ["8"]);
  assert.deepEqual([filled.labels[0], outlined.labels[0], plain.labels[0]], [
    ["8", 40, 50],
    ["8", 40, 50],
    ["8", 40, 50],
  ]);
});

test("counters flatten above later ordinary annotations", () => {
  const counter: Mark = {
    kind: "counter",
    color: "currentColor",
    x: 40,
    y: 50,
    value: 1,
    size: 32,
  };
  const text: Mark = {
    kind: "text",
    color: "currentColor",
    x: 20,
    y: 30,
    text: "Later label",
    size: 20,
  };
  const canvas = new MemoryCanvas(160, new Uint8ClampedArray(160 * 120 * 4));

  paintAll(canvas, [counter, text], 160);

  assert.deepEqual(canvas.labels.map(([label]) => label), ["Later label", "1"]);
});

test("one spotlight dims only outside its focus before annotations paint", () => {
  const spotlight: Mark = { kind: "spotlight", x: 40, y: 30, w: 80, h: 40 };
  const line: Mark = { kind: "line", color: "currentColor", x1: 10, y1: 20, x2: 70, y2: 80 };
  const canvas = new MemoryCanvas(160, new Uint8ClampedArray(160 * 120 * 4));
  paintAll(canvas, [line, spotlight], 160);
  assert.deepEqual(canvas.overlayRects, [
    [0, 0, 160, 30],
    [0, 70, 160, 50],
    [0, 30, 40, 40],
    [120, 30, 40, 40],
  ]);
  assert.deepEqual(canvas.operations, ["spotlight", "spotlight", "spotlight", "spotlight", "line"]);
  assert.deepEqual(new Set(canvas.overlayStyles), new Set(["rgba(0,0,0,0.58)"]));
});

test("spotlight strength and corner resizing preserve a reversible style payload", () => {
  const spotlight: Extract<Mark, { kind: "spotlight" }> = {
    kind: "spotlight",
    x: 40,
    y: 30,
    w: 80,
    h: 40,
    strength: "strong",
  };
  assert.equal(spotlightOpacityFor("soft"), 0.42);
  assert.equal(spotlightOpacityFor(), 0.58);
  assert.equal(spotlightOpacityFor("strong"), 0.72);

  const handles = resizeHandles(spotlight, 800);
  assert.deepEqual(handles.map(({ handle, x, y }) => [handle, x, y]), [
    ["north-west", 40, 30],
    ["north-east", 120, 30],
    ["south-west", 40, 70],
    ["south-east", 120, 70],
  ]);
  assert.equal(hitResizeHandle(spotlight, 121, 71, 800), "south-east");
  assert.equal(hitResizeHandle(spotlight, 80, 50, 800), null);
  assert.deepEqual(resizeMark(spotlight, "north-west", 20, 10), {
    ...spotlight,
    x: 20,
    y: 10,
    w: 100,
    h: 60,
  });

  const canvas = new MemoryCanvas(160, new Uint8ClampedArray(160 * 120 * 4));
  paint(canvas, spotlight, 160);
  assert.deepEqual(new Set(canvas.overlayStyles), new Set(["rgba(0,0,0,0.72)"]));
});

test("spotlight shape variants keep legacy rectangles while cutting rounded and ellipse focus paths", () => {
  const rounded = new MemoryCanvas(160, new Uint8ClampedArray(160 * 120 * 4));
  paint(rounded, {
    kind: "spotlight",
    x: 40,
    y: 30,
    w: 80,
    h: 40,
    spotlightShape: "rounded",
  }, 160);
  assert.equal(rounded.quadraticCurves.length, 4);
  assert.deepEqual(rounded.fillRules, ["evenodd"]);
  assert.deepEqual(rounded.overlayRects, []);

  const ellipse = new MemoryCanvas(160, new Uint8ClampedArray(160 * 120 * 4));
  paint(ellipse, {
    kind: "spotlight",
    x: 40,
    y: 30,
    w: 80,
    h: 40,
    spotlightShape: "ellipse",
  }, 160);
  assert.deepEqual(ellipse.ellipses, [[80, 50, 40, 20, 0, 0, Math.PI * 2]]);
  assert.deepEqual(ellipse.fillRules, ["evenodd"]);
  assert.deepEqual(ellipse.overlayRects, []);

  const legacy = new MemoryCanvas(160, new Uint8ClampedArray(160 * 120 * 4));
  paint(legacy, { kind: "spotlight", x: 40, y: 30, w: 80, h: 40 }, 160);
  assert.equal(legacy.fillRules.length, 0);
  assert.equal(legacy.overlayRects.length, 4);
});

test("rectangle corners and segment endpoints resize every geometry-native tool", () => {
  const rectMarks: Mark[] = [
    { kind: "box", color: "currentColor", x: 20, y: 30, w: 80, h: 40 },
    { kind: "ellipse", color: "currentColor", x: 20, y: 30, w: 80, h: 40 },
    { kind: "blur", x: 20, y: 30, w: 80, h: 40 },
    { kind: "blur_effect", x: 20, y: 30, w: 80, h: 40, blurMode: "smooth" },
  ];
  for (const mark of rectMarks) {
    assert.deepEqual(resizeHandles(mark, 800).map(({ handle }) => handle), [
      "north-west", "north-east", "south-west", "south-east",
    ]);
    assert.deepEqual(resizeMark(mark, "south-east", 140, 100), {
      ...mark,
      w: 120,
      h: 70,
    });
  }

  const arrow: Mark = { kind: "arrow", color: "currentColor", x1: 10, y1: 20, x2: 70, y2: 80 };
  const line: Mark = { ...arrow, kind: "line" };
  for (const mark of [arrow, line]) {
    assert.deepEqual(resizeHandles(mark, 800).map(({ handle, x, y }) => [handle, x, y]), [
      ["start", 10, 20],
      ["end", 70, 80],
    ]);
    assert.equal(hitResizeHandle(mark, 70, 80, 800), "end");
    assert.deepEqual(resizeMark(mark, "end", 100, 110), { ...mark, x2: 100, y2: 110 });
  }

  const text: Mark = { kind: "text", color: "currentColor", x: 10, y: 20, text: "No handle", size: 24 };
  assert.deepEqual(resizeHandles(text, 800), []);
  assert.deepEqual(resizeMark(text, "south-east", 100, 110), text);

  const lineSelection = new MemoryCanvas(800, new Uint8ClampedArray(800 * 200 * 4));
  paintSelection(lineSelection, line, 800);
  assert.equal(lineSelection.arcs.length, 2, "both segment endpoints must be visible editor chrome");
  const rectSelection = new MemoryCanvas(800, new Uint8ClampedArray(800 * 200 * 4));
  paintSelection(rectSelection, rectMarks[1]!, 800);
  assert.equal(rectSelection.arcs.length, 4, "every rectangle corner must be visible editor chrome");
  const textSelection = new MemoryCanvas(800, new Uint8ClampedArray(800 * 200 * 4));
  paintSelection(textSelection, text, 800);
  assert.equal(textSelection.arcs.length, 0);
});

test("Shift precision geometry is stable across every drag direction and modifier change", () => {
  assert.deepEqual(rectFromSquareDrag(100, 80, 160, 110), {
    x: 100,
    y: 80,
    w: 60,
    h: 60,
  });
  assert.deepEqual(rectFromSquareDrag(100, 80, 40, 120), {
    x: 40,
    y: 80,
    w: 60,
    h: 60,
  });
  assert.deepEqual(rectFromSquareDrag(100, 80, 140, 20), {
    x: 100,
    y: 20,
    w: 60,
    h: 60,
  });
  assert.deepEqual(rectFromSquareDrag(100, 80, 40, 20), {
    x: 40,
    y: 20,
    w: 60,
    h: 60,
  });
  assert.deepEqual(axisLockedDelta(71, 24), { x: 71, y: 0 });
  assert.deepEqual(axisLockedDelta(-18, -52), { x: 0, y: -52 });
  assert.deepEqual(axisLockedDelta(30, -30), { x: 30, y: 0 });
});

test("pencil and highlighter smooth bounded point paths without input-density noise", () => {
  const pencil: Extract<Mark, { kind: "pencil" }> = {
    kind: "pencil",
    color: "currentColor",
    strokeWeight: "thin",
    points: [{ x: 10, y: 20 }],
  };
  const ignored = appendFreehandPoint(pencil, { x: 10.5, y: 20.5 }, 800);
  assert.equal(ignored, pencil, "sub-pixel pointer noise must not allocate another point");
  const second = appendFreehandPoint(pencil, { x: 30, y: 40 }, 800);
  const drawn = appendFreehandPoint(second, { x: 70, y: 30 }, 800);
  assert.equal(isDegenerate(drawn), false);
  assert.equal(isDegenerate(pencil), true);
  assert.deepEqual(translate(drawn, 5, -3), {
    ...drawn,
    points: [{ x: 15, y: 17 }, { x: 35, y: 37 }, { x: 75, y: 27 }],
  });
  assert.deepEqual(resizeHandles(drawn, 800), []);
  assert.ok(boundsOf(drawn, 800).w > 60);

  const pencilCanvas = new MemoryCanvas(800, new Uint8ClampedArray(800 * 100 * 4));
  paint(pencilCanvas, drawn, 800);
  assert.equal(pencilCanvas.quadraticCurves.length, 1);
  assert.equal(pencilCanvas.globalAlpha, 1);

  const highlighter: Mark = { ...drawn, kind: "highlighter", strokeWeight: "bold" };
  const highlighterCanvas = new MemoryCanvas(800, new Uint8ClampedArray(800 * 100 * 4));
  paint(highlighterCanvas, highlighter, 800);
  assert.equal(highlighterCanvas.quadraticCurves.length, 1);
  assert.equal(highlighterCanvas.strokeWidths.at(-1), highlighterStrokeFor(800, "bold"));
  assert.equal(highlighterCanvas.strokeAlphas.at(-1), highlighterOpacityFor());
  assert.equal(highlighterCanvas.globalAlpha, 1, "translucent ink must restore later annotations to opaque");

  const softCanvas = new MemoryCanvas(800, new Uint8ClampedArray(800 * 100 * 4));
  paint(softCanvas, { ...highlighter, highlighterOpacity: "soft" } as Mark, 800);
  const strongCanvas = new MemoryCanvas(800, new Uint8ClampedArray(800 * 100 * 4));
  paint(strongCanvas, { ...highlighter, highlighterOpacity: "strong" } as Mark, 800);
  assert.equal(softCanvas.strokeAlphas.at(-1), highlighterOpacityFor("soft"));
  assert.equal(strongCanvas.strokeAlphas.at(-1), highlighterOpacityFor("strong"));
  assert.ok(softCanvas.strokeAlphas.at(-1)! < highlighterCanvas.strokeAlphas.at(-1)!);
  assert.ok(highlighterCanvas.strokeAlphas.at(-1)! < strongCanvas.strokeAlphas.at(-1)!);
});

test("Smart Highlighter detects a reliable local text band and ignores flat pixels", () => {
  const width = 120;
  const height = 60;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels.set([246, 246, 246, 255], offset);
  }
  for (let y = 24; y <= 31; y += 1) {
    for (let x = 18; x <= 102; x += 1) {
      if ((x % 13) < 9) pixels.set([30, 34, 42, 255], (y * width + x) * 4);
    }
  }

  assert.deepEqual(detectSmartHighlightBand(pixels, width, height, 60, 28), {
    centerY: 27.5,
    strokeWidth: 12,
  });

  const flat = new Uint8ClampedArray(width * height * 4).fill(255);
  assert.equal(detectSmartHighlightBand(flat, width, height, 60, 28), null);
  assert.equal(detectSmartHighlightBand(pixels, width, height, 60, 55), null);
});

test("a detected Smart Highlighter width is exact and survives Eraser geometry", () => {
  const smart: Extract<Mark, { kind: "highlighter" }> = {
    kind: "highlighter",
    color: "currentColor",
    points: [{ x: 10, y: 30 }, { x: 90, y: 30 }],
    smartWidth: 18,
  };
  const canvas = new MemoryCanvas(240, new Uint8ClampedArray(240 * 80 * 4));
  paint(canvas, smart, 240);
  assert.equal(canvas.strokeWidths.at(-1), 18);
  const before = [smart];
  const erased = eraseFreehandMarks(before, [{ x: 50, y: 49 }], 240);
  assert.notEqual(erased, before);
  assert.deepEqual(erased, []);
  const manual: Extract<Mark, { kind: "highlighter" }> = { ...smart, smartWidth: undefined };
  const manualMarks = [manual];
  assert.equal(eraseFreehandMarks(manualMarks, [{ x: 50, y: 49 }], 240), manualMarks);
});

test("all eight image orientations round-trip source points, dimensions and matrices", () => {
  const transforms = ([0, 1, 2, 3] as const).flatMap((quarterTurns) => ([
    { quarterTurns, flipped: false },
    { quarterTurns, flipped: true },
  ]));
  for (const transform of transforms) {
    const output = imageTransformOutputSize(100, 60, transform);
    assert.deepEqual(output, quarterTurnsIsOdd(transform.quarterTurns)
      ? { width: 60, height: 100 }
      : { width: 100, height: 60 });
    const source = { x: 23, y: 17 };
    const transformed = imagePointToOutput(source, 100, 60, transform);
    assert.deepEqual(imagePointFromOutput(transformed, 100, 60, transform), source);
    const [a, b, c, d, e, f] = imageTransformMatrix(100, 60, transform);
    assert.deepEqual(transformed, {
      x: a * source.x + c * source.y + e,
      y: b * source.x + d * source.y + f,
    });
  }
});

test("resolution scaling stays proportional after orientation and rejects unsafe output sizes", () => {
  assert.deepEqual(imageScaleOutputSize(1280, 760, { quarterTurns: 0, flipped: false }, 0.5), {
    width: 640,
    height: 380,
  });
  assert.deepEqual(imageScaleOutputSize(1280, 760, { quarterTurns: 1, flipped: true }, 0.5), {
    width: 380,
    height: 640,
  });
  const widthScale = imageScaleForOutputDimension(
    500,
    "width",
    1280,
    760,
    { quarterTurns: 0, flipped: false },
  );
  assert.equal(widthScale, 500 / 1280);
  assert.deepEqual(imageScaleOutputSize(1280, 760, { quarterTurns: 0, flipped: false }, widthScale), {
    width: 500,
    height: 297,
  });
  assert.equal(isValidImageScale(1280, 760, { quarterTurns: 0, flipped: false }, widthScale), true);
  assert.equal(isValidImageScale(1280, 760, { quarterTurns: 0, flipped: false }, 0.001), false);
  assert.equal(isValidImageScale(1280, 760, { quarterTurns: 0, flipped: false }, 8), false);
  assert.equal(isValidImageScale(1280, 760, { quarterTurns: 0, flipped: false }, Number.NaN), false);
});

test("Rotate and display-relative flips compose canonically and map keyboard deltas", () => {
  const identity = { quarterTurns: 0 as const, flipped: false };
  const right = updateImageTransform(identity, "rotate_right");
  assert.deepEqual(right, { quarterTurns: 1, flipped: false });
  assert.deepEqual(imageDeltaFromOutput(1, 0, right), { x: 0, y: -1 });
  assert.deepEqual(updateImageTransform(right, "flip_horizontal"), { quarterTurns: 3, flipped: true });
  assert.deepEqual(updateImageTransform(right, "flip_vertical"), { quarterTurns: 1, flipped: true });
  assert.deepEqual(updateImageTransform(updateImageTransform(identity, "flip_horizontal"), "rotate_right"), {
    quarterTurns: 1,
    flipped: true,
  });
  assert.deepEqual(updateImageTransform(right, "reset"), identity);
});

function quarterTurnsIsOdd(value: 0 | 1 | 2 | 3) {
  return value === 1 || value === 3;
}

test("one eraser sweep splits only intersecting pencil and highlighter paths", () => {
  const pencil: Extract<Mark, { kind: "pencil" }> = {
    kind: "pencil",
    color: "currentColor",
    points: Array.from({ length: 21 }, (_, index) => ({ x: index * 5, y: 20 })),
  };
  const highlighter: Extract<Mark, { kind: "highlighter" }> = {
    ...pencil,
    kind: "highlighter",
    points: pencil.points.map(({ x }) => ({ x, y: 60 })),
  };
  const box: Mark = { kind: "box", color: "currentColor", x: 20, y: 10, w: 60, h: 70 };
  const before = [pencil, highlighter, box];

  const after = eraseFreehandMarks(before, [{ x: 50, y: 0 }, { x: 50, y: 40 }], 240);

  assert.equal(eraserRadiusFor(240), 10);
  assert.equal(after.length, 4);
  assert.deepEqual(after.slice(2), [highlighter, box], "ordinary marks and untouched ink stay byte-exact");
  assert.deepEqual(after.slice(0, 2).map((mark) => mark.kind), ["pencil", "pencil"]);
  assert.ok(after[0]!.kind === "pencil" && after[0]!.points.at(-1)!.x < 50);
  assert.ok(after[1]!.kind === "pencil" && after[1]!.points[0]!.x > 50);
  assert.equal(
    eraseFreehandMarks(before, [{ x: 220, y: 110 }], 240),
    before,
    "a missed sweep must preserve the exact array identity",
  );
});

test("nested crop drags snap to safe source pixels and never escape the current viewport", () => {
  const current = { x: 100, y: 50, w: 500, h: 300 };
  assert.deepEqual(cropFromDrag(540.2, 260.8, 160.7, 80.1, current), {
    x: 160,
    y: 80,
    w: 381,
    h: 181,
  });
  assert.deepEqual(cropFromDrag(-50, -50, 900, 900, current), current);
  assert.equal(isDegenerateCrop({ x: 10, y: 10, w: 15, h: 40 }), true);
  assert.equal(isDegenerateCrop({ x: 10.5, y: 10, w: 40, h: 40 }), true);
  assert.equal(isDegenerateCrop({ x: 10, y: 10, w: 40, h: 40 }), false);
});

test("crop aspect presets keep exact integer ratios from the drag anchor", () => {
  const current = { x: 100, y: 50, w: 500, h: 300 };
  assert.deepEqual(cropFromDragWithAspect(200.2, 100.4, 430.7, 230.1, current, "square"), {
    x: 200,
    y: 100,
    w: 231,
    h: 231,
  });
  assert.deepEqual(cropFromDragWithAspect(150.8, 90.2, 351.1, 205.8, current, "4:3"), {
    x: 150,
    y: 90,
    w: 204,
    h: 153,
  });
  assert.deepEqual(cropFromDragWithAspect(120.9, 70.6, 389.2, 201.3, current, "16:9"), {
    x: 120,
    y: 70,
    w: 272,
    h: 153,
  });
  assert.deepEqual(cropFromDragWithAspect(150.8, 90.2, 351.1, 205.8, current, "5:4"), {
    x: 150,
    y: 90,
    w: 205,
    h: 164,
  });
  assert.deepEqual(cropFromDragWithAspect(120.9, 70.6, 200.1, 300.2, current, "9:16"), {
    x: 120,
    y: 70,
    w: 135,
    h: 240,
  });
});

test("aspect-locked crop shrinks at nested viewport edges instead of distorting", () => {
  const current = { x: 100, y: 50, w: 500, h: 300 };
  assert.deepEqual(cropFromDragWithAspect(540.2, 260.8, 160.7, 80.1, current, "4:3"), {
    x: 260,
    y: 50,
    w: 280,
    h: 210,
  });
  assert.deepEqual(cropFromDragWithAspect(560.5, 310.1, 900, 900, current, "16:9"), {
    x: 560,
    y: 310,
    w: 32,
    h: 18,
  });
});
