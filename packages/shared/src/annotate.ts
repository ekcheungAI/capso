/**
 * The drawing model for the quick annotation editor (05 §3).
 *
 * Kept apart from the React component so the geometry — which is where the bugs
 * live — can be exercised under plain node. The component owns pointers and
 * canvases; this file owns what a mark *is* and how it is painted.
 *
 * The original MVP deliberately stopped at four tools. The full-product parity
 * contract now keeps geometry, crop coordinates and editable mark payloads in
 * this shared model while the Mac native boundary owns durable revisions.
 */

import { annotate as annotateInk } from "./tokens.ts";

export type Tool =
  | "arrow" | "line" | "box" | "ellipse" | "text"
  | "pencil" | "highlighter" | "eraser" | "counter" | "spotlight" | "blur" | "blur-effect" | "crop";

export type AnnotationCrop = { x: number; y: number; w: number; h: number };
export type CropAspect = "square" | "4:3" | "5:4" | "16:9" | "9:16";
export type ImageTransform = {
  quarterTurns: 0 | 1 | 2 | 3;
  flipped: boolean;
};
export type ImageTransformAction =
  | "rotate_right" | "rotate_left" | "flip_horizontal" | "flip_vertical" | "reset";
export const DEFAULT_IMAGE_TRANSFORM: ImageTransform = { quarterTurns: 0, flipped: false };
export const DEFAULT_IMAGE_SCALE = 1;
export const MIN_ANNOTATION_OUTPUT_DIMENSION = 16;
export const MAX_ANNOTATION_OUTPUT_DIMENSION = 16_384;
export const MAX_ANNOTATION_OUTPUT_PIXELS = 32 * 1_024 * 1_024;

export const isDefaultImageTransform = (transform: ImageTransform) => (
  transform.quarterTurns === 0 && !transform.flipped
);

export function imageTransformOutputSize(
  width: number,
  height: number,
  transform: ImageTransform,
) {
  return transform.quarterTurns === 1 || transform.quarterTurns === 3
    ? { width: height, height: width }
    : { width, height };
}

export function imageScaleOutputSize(
  width: number,
  height: number,
  transform: ImageTransform,
  imageScale: number,
) {
  const oriented = imageTransformOutputSize(width, height, transform);
  return {
    width: Math.max(1, Math.round(oriented.width * imageScale)),
    height: Math.max(1, Math.round(oriented.height * imageScale)),
  };
}

export function imageScaleForOutputDimension(
  target: number,
  dimension: "width" | "height",
  width: number,
  height: number,
  transform: ImageTransform,
) {
  const oriented = imageTransformOutputSize(width, height, transform);
  return target / oriented[dimension];
}

export function isValidImageScale(
  width: number,
  height: number,
  transform: ImageTransform,
  imageScale: number,
) {
  if (!Number.isFinite(imageScale) || imageScale <= 0) return false;
  const output = imageScaleOutputSize(width, height, transform, imageScale);
  return output.width >= MIN_ANNOTATION_OUTPUT_DIMENSION
    && output.height >= MIN_ANNOTATION_OUTPUT_DIMENSION
    && output.width <= MAX_ANNOTATION_OUTPUT_DIMENSION
    && output.height <= MAX_ANNOTATION_OUTPUT_DIMENSION
    && output.width * output.height <= MAX_ANNOTATION_OUTPUT_PIXELS;
}

/** Canvas affine matrix for applying a source-space orientation once at output. */
export function imageTransformMatrix(
  width: number,
  height: number,
  transform: ImageTransform,
): [number, number, number, number, number, number] {
  if (!transform.flipped) {
    if (transform.quarterTurns === 1) return [0, 1, -1, 0, height, 0];
    if (transform.quarterTurns === 2) return [-1, 0, 0, -1, width, height];
    if (transform.quarterTurns === 3) return [0, -1, 1, 0, 0, width];
    return [1, 0, 0, 1, 0, 0];
  }
  if (transform.quarterTurns === 1) return [0, -1, -1, 0, height, width];
  if (transform.quarterTurns === 2) return [1, 0, 0, -1, 0, height];
  if (transform.quarterTurns === 3) return [0, 1, 1, 0, 0, 0];
  return [-1, 0, 0, 1, width, 0];
}

export function imagePointToOutput(
  point: AnnotationPoint,
  width: number,
  height: number,
  transform: ImageTransform,
): AnnotationPoint {
  const [a, b, c, d, e, f] = imageTransformMatrix(width, height, transform);
  return { x: a * point.x + c * point.y + e, y: b * point.x + d * point.y + f };
}

export function imagePointFromOutput(
  point: AnnotationPoint,
  width: number,
  height: number,
  transform: ImageTransform,
): AnnotationPoint {
  const { quarterTurns, flipped } = transform;
  if (!flipped) {
    if (quarterTurns === 1) return { x: point.y, y: height - point.x };
    if (quarterTurns === 2) return { x: width - point.x, y: height - point.y };
    if (quarterTurns === 3) return { x: width - point.y, y: point.x };
    return point;
  }
  if (quarterTurns === 1) return { x: width - point.y, y: height - point.x };
  if (quarterTurns === 2) return { x: point.x, y: height - point.y };
  if (quarterTurns === 3) return { x: point.y, y: point.x };
  return { x: width - point.x, y: point.y };
}

export function imageDeltaFromOutput(
  x: number,
  y: number,
  transform: ImageTransform,
): AnnotationPoint {
  const { quarterTurns, flipped } = transform;
  if (!flipped) {
    if (quarterTurns === 1) return { x: y, y: -x };
    if (quarterTurns === 2) return { x: -x, y: -y };
    if (quarterTurns === 3) return { x: -y, y: x };
    return { x, y };
  }
  if (quarterTurns === 1) return { x: -y, y: -x };
  if (quarterTurns === 2) return { x, y: -y };
  if (quarterTurns === 3) return { x: y, y: x };
  return { x: -x, y };
}

export function updateImageTransform(
  transform: ImageTransform,
  action: ImageTransformAction,
): ImageTransform {
  if (action === "reset") return DEFAULT_IMAGE_TRANSFORM;
  if (action === "rotate_right") {
    return { ...transform, quarterTurns: ((transform.quarterTurns + 1) % 4) as ImageTransform["quarterTurns"] };
  }
  if (action === "rotate_left") {
    return { ...transform, quarterTurns: ((transform.quarterTurns + 3) % 4) as ImageTransform["quarterTurns"] };
  }
  const base = action === "flip_horizontal" ? -transform.quarterTurns : 2 - transform.quarterTurns;
  return {
    quarterTurns: ((base + 4) % 4) as ImageTransform["quarterTurns"],
    flipped: !transform.flipped,
  };
}

export function cropFromDrag(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  bounds: AnnotationCrop,
): AnnotationCrop {
  const left = Math.max(bounds.x, Math.min(bounds.x + bounds.w, Math.floor(Math.min(x1, x2))));
  const top = Math.max(bounds.y, Math.min(bounds.y + bounds.h, Math.floor(Math.min(y1, y2))));
  const right = Math.max(bounds.x, Math.min(bounds.x + bounds.w, Math.ceil(Math.max(x1, x2))));
  const bottom = Math.max(bounds.y, Math.min(bounds.y + bounds.h, Math.ceil(Math.max(y1, y2))));
  return { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) };
}

export function cropFromDragWithAspect(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  bounds: AnnotationCrop,
  aspect: CropAspect,
): AnnotationCrop {
  const ratios: Record<CropAspect, readonly [number, number]> = {
    square: [1, 1],
    "4:3": [4, 3],
    "5:4": [5, 4],
    "16:9": [16, 9],
    "9:16": [9, 16],
  };
  const [ratioWidth, ratioHeight] = ratios[aspect];
  const anchorX = Math.max(bounds.x, Math.min(bounds.x + bounds.w, Math.floor(x1)));
  const anchorY = Math.max(bounds.y, Math.min(bounds.y + bounds.h, Math.floor(y1)));
  const directionX = x2 >= x1 ? 1 : -1;
  const directionY = y2 >= y1 ? 1 : -1;
  const availableWidth = directionX > 0
    ? bounds.x + bounds.w - anchorX
    : anchorX - bounds.x;
  const availableHeight = directionY > 0
    ? bounds.y + bounds.h - anchorY
    : anchorY - bounds.y;
  const desiredUnits = Math.ceil(Math.max(
    Math.abs(x2 - x1) / ratioWidth,
    Math.abs(y2 - y1) / ratioHeight,
  ));
  const maximumUnits = Math.floor(Math.min(
    availableWidth / ratioWidth,
    availableHeight / ratioHeight,
  ));
  const units = Math.max(0, Math.min(desiredUnits, maximumUnits));
  const width = units * ratioWidth;
  const height = units * ratioHeight;
  return {
    x: directionX > 0 ? anchorX : anchorX - width,
    y: directionY > 0 ? anchorY : anchorY - height,
    w: width,
    h: height,
  };
}

export const isDegenerateCrop = (crop: AnnotationCrop) => (
  ![crop.x, crop.y, crop.w, crop.h].every(Number.isSafeInteger)
  || crop.w < 16
  || crop.h < 16
);

/**
 * Red default plus four, per 05 §3 — a preset palette, not a colour picker.
 * Read from the brand tokens rather than written here: `pnpm brand:check` fails
 * the build on a hex literal in source, and it is right to.
 */
export const PALETTE = [
  annotateInk.red!, annotateInk.amber!, annotateInk.green!, annotateInk.blue!, annotateInk.purple!,
] as const;
export const DEFAULT_COLOR = PALETTE[0];

export type StrokeWeight = "thin" | "regular" | "bold";
export const DEFAULT_STROKE_WEIGHT: StrokeWeight = "regular";
export type HighlighterOpacity = "soft" | "regular" | "strong";
export const DEFAULT_HIGHLIGHTER_OPACITY: HighlighterOpacity = "regular";
export type ArrowStyle = "classic" | "open" | "curved" | "double";
export const DEFAULT_ARROW_STYLE: ArrowStyle = "classic";
export type TextStyle =
  | "standard" | "rounded" | "monospaced" | "outlined"
  | "boxed" | "rounded-boxed" | "monospaced-boxed";
export const DEFAULT_TEXT_STYLE: TextStyle = "standard";
export type SpotlightStrength = "soft" | "regular" | "strong";
export const DEFAULT_SPOTLIGHT_STRENGTH: SpotlightStrength = "regular";
export type SpotlightShape = "rectangle" | "rounded" | "ellipse";
export const DEFAULT_SPOTLIGHT_SHAPE: SpotlightShape = "rectangle";
export type SizePreset = "small" | "regular" | "large";
export const DEFAULT_SIZE_PRESET: SizePreset = "regular";
export type CounterStyle = "filled" | "outlined" | "plain";
export const DEFAULT_COUNTER_STYLE: CounterStyle = "filled";
export type BlurMode = "secure" | "smooth";
export const DEFAULT_BLUR_MODE: BlurMode = "secure";
export type BlurStrength = "soft" | "regular" | "strong";
export const DEFAULT_BLUR_STRENGTH: BlurStrength = "regular";

type StrokeMark = {
  color: string;
  strokeWeight?: StrokeWeight;
};

export type AnnotationPoint = { x: number; y: number };

export type Mark =
  | ({ kind: "arrow"; x1: number; y1: number; x2: number; y2: number; arrowStyle?: ArrowStyle } & StrokeMark)
  | ({ kind: "line"; x1: number; y1: number; x2: number; y2: number } & StrokeMark)
  | ({ kind: "box"; x: number; y: number; w: number; h: number; filled?: boolean } & StrokeMark)
  | ({ kind: "ellipse"; x: number; y: number; w: number; h: number; filled?: boolean } & StrokeMark)
  | { kind: "text"; color: string; x: number; y: number; text: string; size: number; textStyle?: TextStyle }
  | ({ kind: "pencil"; points: AnnotationPoint[] } & StrokeMark)
  | ({
      kind: "highlighter";
      points: AnnotationPoint[];
      smartWidth?: number;
      highlighterOpacity?: HighlighterOpacity;
    } & StrokeMark)
  | {
      kind: "counter";
      color: string;
      x: number;
      y: number;
      value: number;
      size: number;
      counterStyle?: CounterStyle;
    }
  | {
      kind: "spotlight";
      x: number;
      y: number;
      w: number;
      h: number;
      strength?: SpotlightStrength;
      spotlightShape?: SpotlightShape;
    }
  | { kind: "blur"; x: number; y: number; w: number; h: number }
  | {
      kind: "blur_effect";
      x: number;
      y: number;
      w: number;
      h: number;
      blurMode?: BlurMode;
      blurStrength?: BlurStrength;
    };

/**
 * The small Canvas 2D surface this model needs. Keeping the structural contract
 * here lets the shared package typecheck in Node while real browser contexts
 * and test doubles both satisfy it without a DOM dependency.
 */
export type AnnotationCanvasContext = {
  canvas: { width: number; height: number };
  strokeStyle: string | object;
  fillStyle: string | object;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  font: string;
  textBaseline: string;
  textAlign: string;
  lineDashOffset: number;
  globalAlpha: number;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeText(text: string, x: number, y: number): void;
  fillText(text: string, x: number, y: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  ellipse(x: number, y: number, radiusX: number, radiusY: number, rotation: number, startAngle: number, endAngle: number): void;
  closePath(): void;
  stroke(): void;
  fill(fillRule?: "nonzero" | "evenodd"): void;
  getImageData(x: number, y: number, w: number, h: number): {
    data: Uint8ClampedArray;
    width: number;
    height: number;
  };
  putImageData(
    imageData: { data: Uint8ClampedArray; width: number; height: number },
    x: number,
    y: number,
  ): void;
  setLineDash(segments: number[]): void;
  save(): void;
  restore(): void;
};

/** Stroke width and text size scale with the image so a mark reads the same on a
 *  1600px capture as on a 600px one. The regular weight preserves the original
 *  output exactly; thin and bold stay proportional at every capture size. */
export const strokeFor = (
  imageWidth: number,
  weight: StrokeWeight = DEFAULT_STROKE_WEIGHT,
) => {
  const regular = Math.max(2, Math.round(imageWidth / 320));
  if (weight === "thin") return Math.max(1, Math.round(regular * 0.6));
  if (weight === "bold") return Math.max(3, Math.round(regular * 1.8));
  return regular;
};
export const textSizeFor = (imageWidth: number) => Math.max(14, Math.round(imageWidth / 40));
export const counterSizeFor = (imageWidth: number) => Math.max(24, Math.round(imageWidth / 24));
export const sizeForPreset = (regular: number, preset: SizePreset) => Math.max(
  1,
  Math.round(regular * (preset === "small" ? 0.78 : preset === "large" ? 1.3 : 1)),
);
export const closestSizePreset = (size: number, regular: number): SizePreset => {
  const candidates: SizePreset[] = ["small", "regular", "large"];
  return candidates.reduce((closest, candidate) => (
    Math.abs(sizeForPreset(regular, candidate) - size) < Math.abs(sizeForPreset(regular, closest) - size)
      ? candidate
      : closest
  ), DEFAULT_SIZE_PRESET);
};
export const highlighterStrokeFor = (
  imageWidth: number,
  weight: StrokeWeight = DEFAULT_STROKE_WEIGHT,
) => {
  const regular = Math.max(12, Math.round(imageWidth / 48));
  if (weight === "thin") return Math.max(8, Math.round(regular * 0.72));
  if (weight === "bold") return Math.max(16, Math.round(regular * 1.42));
  return regular;
};
export const highlighterWidthFor = (
  mark: Extract<Mark, { kind: "highlighter" }>,
  imageWidth: number,
) => mark.smartWidth ?? highlighterStrokeFor(imageWidth, mark.strokeWeight);
export const spotlightOpacityFor = (
  strength: SpotlightStrength = DEFAULT_SPOTLIGHT_STRENGTH,
) => strength === "soft" ? 0.42 : strength === "strong" ? 0.72 : 0.58;

export const nextCounterValue = (marks: Mark[], startingValue = 1) => {
  const start = Number.isSafeInteger(startingValue) && startingValue >= 0 ? startingValue : 1;
  const highest = marks.reduce(
    (value, mark) => mark.kind === "counter" ? Math.max(value, mark.value) : value,
    -1,
  );
  return Math.max(start, highest + 1);
};

export function arrowCurveControl(
  arrow: Pick<Extract<Mark, { kind: "arrow" }>, "x1" | "y1" | "x2" | "y2">,
) {
  const dx = arrow.x2 - arrow.x1;
  const dy = arrow.y2 - arrow.y1;
  const length = Math.hypot(dx, dy);
  if (length === 0) return { x: arrow.x1, y: arrow.y1 };
  const bow = length * 0.28;
  return {
    x: (arrow.x1 + arrow.x2) / 2 + (dy / length) * bow,
    y: (arrow.y1 + arrow.y2) / 2 - (dx / length) * bow,
  };
}

export function textLayout(mark: Extract<Mark, { kind: "text" }>) {
  const style = mark.textStyle ?? DEFAULT_TEXT_STYLE;
  const monospaced = style === "monospaced" || style === "monospaced-boxed";
  const rounded = style === "rounded" || style === "rounded-boxed";
  const boxed = style === "boxed" || style === "rounded-boxed" || style === "monospaced-boxed";
  const width = mark.text.length * mark.size * (monospaced ? 0.62 : 0.6);
  const padX = boxed ? mark.size * (style === "rounded-boxed" ? 0.5 : 0.36) : 0;
  const padY = boxed ? mark.size * 0.22 : 0;
  const weight = style === "standard" ? 600 : rounded ? 720 : style === "outlined" ? 750 : 650;
  const font = `${weight} ${mark.size}px ${
    monospaced
      ? "ui-monospace, SFMono-Regular, Menlo, monospace"
      : rounded
        ? "ui-rounded, system-ui, sans-serif"
        : "ui-sans-serif, system-ui, sans-serif"
  }`;
  return {
    style,
    boxed,
    font,
    textWidth: width,
    background: {
      x: mark.x - padX,
      y: mark.y - padY,
      w: width + padX * 2,
      h: mark.size + padY * 2,
      radius: style === "rounded-boxed" ? (mark.size + padY * 2) / 2 : mark.size * 0.12,
    },
  };
}

export function fitTextWithinCanvas(
  mark: Extract<Mark, { kind: "text" }>,
  canvasWidth: number,
  canvasHeight: number,
) {
  const layout = textLayout(mark);
  const visual = layout.boxed
    ? layout.background
    : { x: mark.x, y: mark.y, w: layout.textWidth, h: mark.size };
  const shiftX = visual.w >= canvasWidth
    ? -visual.x
    : visual.x < 0
      ? -visual.x
      : visual.x + visual.w > canvasWidth
        ? canvasWidth - visual.x - visual.w
        : 0;
  const shiftY = visual.h >= canvasHeight
    ? -visual.y
    : visual.y < 0
      ? -visual.y
      : visual.y + visual.h > canvasHeight
        ? canvasHeight - visual.y - visual.h
        : 0;
  return { ...mark, x: mark.x + shiftX, y: mark.y + shiftY };
}

/**
 * Normalise a drag into a rect with positive width and height.
 *
 * Dragging right-to-left or bottom-to-top is completely ordinary, and without
 * this a backwards drag produces a negative-size rect: `fillRect` tolerates it,
 * `getImageData` throws, so the blur tool would break on half of all drags.
 */
export function rectFrom(x1: number, y1: number, x2: number, y2: number) {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1),
  };
}

/** Keep a rectangle drag square without losing the pointer's drag quadrant. */
export function rectFromSquareDrag(x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  const constrainedX = x1 + side * (Math.sign(dx) || 1);
  const constrainedY = y1 + side * (Math.sign(dy) || 1);
  return rectFrom(x1, y1, constrainedX, constrainedY);
}

/** Lock a drag to its dominant axis; exact ties resolve horizontally. */
export function axisLockedDelta(dx: number, dy: number): AnnotationPoint {
  return Math.abs(dx) >= Math.abs(dy) ? { x: dx, y: 0 } : { x: 0, y: dy };
}

/** Every number a mark carries, for the finite check below. */
const coordsOf = (m: Mark): number[] =>
  (m.kind === "arrow" || m.kind === "line") ? [m.x1, m.y1, m.x2, m.y2]
  : m.kind === "highlighter" ? [
      ...m.points.flatMap(({ x, y }) => [x, y]),
      ...(m.smartWidth === undefined ? [] : [m.smartWidth]),
    ]
  : m.kind === "pencil" ? m.points.flatMap(({ x, y }) => [x, y])
  : (m.kind === "text" || m.kind === "counter") ? [m.x, m.y, m.size]
  : [m.x, m.y, m.w, m.h];

/**
 * A drag too small to be deliberate — a click that slipped, not a mark.
 *
 * The `Number.isFinite` guard is not defensive padding. A canvas with no layout
 * size — a very short window, or one measured before layout settles — makes the
 * screen-to-image conversion divide by zero, producing `NaN` coordinates. Every
 * size comparison against `NaN` is `false`, so without this an entirely invalid
 * mark passes the check, is committed, and then paints nothing at all: the
 * editor appears to swallow the drag with no error anywhere.
 */
export const isDegenerate = (m: Mark) => {
  if (!coordsOf(m).every(Number.isFinite)) return true;
  if (m.kind === "counter") return !Number.isSafeInteger(m.value) || m.value < 0 || m.size < 1;
  if (m.kind === "pencil" || m.kind === "highlighter") {
    if (m.kind === "highlighter" && m.smartWidth !== undefined && (m.smartWidth < 4 || m.smartWidth > 256)) {
      return true;
    }
    if (m.points.length < 2) return true;
    let length = 0;
    for (let index = 1; index < m.points.length; index += 1) {
      length += Math.hypot(
        m.points[index]!.x - m.points[index - 1]!.x,
        m.points[index]!.y - m.points[index - 1]!.y,
      );
    }
    return length < 6;
  }
  return (m.kind === "box" || m.kind === "ellipse" || m.kind === "spotlight" || m.kind === "blur" || m.kind === "blur_effect") ? m.w < 4 || m.h < 4
    : (m.kind === "arrow" || m.kind === "line") ? Math.hypot(m.x2 - m.x1, m.y2 - m.y1) < 6
    : m.text.trim().length === 0;
};

// -------------------------------------------------------------- editing ----

/**
 * The rectangle a mark occupies, for hit-testing and for drawing the selection
 * ring around it.
 *
 * Text is approximated at 0.6em per character rather than measured: measuring
 * needs a canvas context, which would make this impure and untestable, and the
 * only consumers are "did the pointer land on this label" and "where do I draw a
 * dashed box" — both of which tolerate being a few pixels out.
 */
export function boundsOf(m: Mark, imageWidth: number) {
  const weight = "strokeWeight" in m ? m.strokeWeight : undefined;
  const pad = strokeFor(imageWidth, weight) * 2;
  if (m.kind === "box" || m.kind === "ellipse" || m.kind === "spotlight" || m.kind === "blur" || m.kind === "blur_effect") {
    return { x: m.x - pad, y: m.y - pad, w: m.w + pad * 2, h: m.h + pad * 2 };
  }
  if (m.kind === "text") {
    const layout = textLayout(m);
    const visual = layout.boxed
      ? layout.background
      : { x: m.x, y: m.y, w: layout.textWidth, h: m.size };
    return { x: visual.x - pad, y: visual.y - pad, w: visual.w + pad * 2, h: visual.h + pad * 2 };
  }
  if (m.kind === "counter") {
    return { x: m.x - m.size / 2 - pad, y: m.y - m.size / 2 - pad, w: m.size + pad * 2, h: m.size + pad * 2 };
  }
  if (m.kind === "pencil" || m.kind === "highlighter") {
    const xs = m.points.map(({ x }) => x);
    const ys = m.points.map(({ y }) => y);
    const freehandPad = (m.kind === "highlighter"
      ? highlighterWidthFor(m, imageWidth)
      : strokeFor(imageWidth, m.strokeWeight)) / 2 + pad;
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    const right = Math.max(...xs);
    const bottom = Math.max(...ys);
    return {
      x: left - freehandPad,
      y: top - freehandPad,
      w: right - left + freehandPad * 2,
      h: bottom - top + freehandPad * 2,
    };
  }
  if (m.kind === "arrow" && (m.arrowStyle ?? DEFAULT_ARROW_STYLE) === "curved") {
    const control = arrowCurveControl(m);
    const points = Array.from({ length: 17 }, (_, index) => {
      const t = index / 16;
      const inverse = 1 - t;
      return {
        x: inverse * inverse * m.x1 + 2 * inverse * t * control.x + t * t * m.x2,
        y: inverse * inverse * m.y1 + 2 * inverse * t * control.y + t * t * m.y2,
      };
    });
    const xs = points.map(({ x }) => x);
    const ys = points.map(({ y }) => y);
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    const right = Math.max(...xs);
    const bottom = Math.max(...ys);
    return { x: left - pad, y: top - pad, w: right - left + pad * 2, h: bottom - top + pad * 2 };
  }
  const r = rectFrom(m.x1, m.y1, m.x2, m.y2);
  return { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
}

/**
 * Index of the topmost mark under a point, or null.
 *
 * Searched last-to-first because later marks paint over earlier ones — clicking
 * where two overlap should grab the one you can actually see.
 */
export function hitTest(marks: Mark[], x: number, y: number, imageWidth: number): number | null {
  for (let i = marks.length - 1; i >= 0; i--) {
    const b = boundsOf(marks[i]!, imageWidth);
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return i;
  }
  return null;
}

/** Shift a mark. Every coordinate it owns moves; nothing else changes. */
export function translate(m: Mark, dx: number, dy: number): Mark {
  if (m.kind === "arrow" || m.kind === "line") return { ...m, x1: m.x1 + dx, y1: m.y1 + dy, x2: m.x2 + dx, y2: m.y2 + dy };
  if (m.kind === "pencil" || m.kind === "highlighter") {
    return { ...m, points: m.points.map(({ x, y }) => ({ x: x + dx, y: y + dy })) };
  }
  return { ...m, x: m.x + dx, y: m.y + dy };
}

export function appendFreehandPoint(
  mark: Extract<Mark, { kind: "pencil" | "highlighter" }>,
  point: AnnotationPoint,
  imageWidth: number,
): Extract<Mark, { kind: "pencil" | "highlighter" }> {
  const previous = mark.points.at(-1);
  const minimumDistance = Math.max(1, imageWidth / 640);
  if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < minimumDistance) {
    return mark;
  }
  return { ...mark, points: [...mark.points, point] };
}

export type SmartHighlightBand = { centerY: number; strokeWidth: number };

/** Detect one reliable text row inside a small protected-original RGBA sample. */
export function detectSmartHighlightBand(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  anchorX: number,
  anchorY: number,
): SmartHighlightBand | null {
  if (
    !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width < 16 || height < 16 || width > 512 || height > 256
    || rgba.length !== width * height * 4
    || ![anchorX, anchorY].every(Number.isFinite)
    || anchorX < 0 || anchorX >= width || anchorY < 0 || anchorY >= height
  ) return null;
  const luminanceAt = (x: number, y: number) => {
    const offset = (y * width + x) * 4;
    return rgba[offset]! * 0.2126 + rgba[offset + 1]! * 0.7152 + rgba[offset + 2]! * 0.0722;
  };
  const border: number[] = [];
  for (let x = 0; x < width; x += 1) {
    border.push(luminanceAt(x, 0), luminanceAt(x, height - 1));
  }
  for (let y = 1; y < height - 1; y += 1) {
    border.push(luminanceAt(0, y), luminanceAt(width - 1, y));
  }
  border.sort((left, right) => left - right);
  const background = border[Math.floor(border.length / 2)]!;
  const minimumRowInk = Math.max(3, Math.floor(width * 0.025));
  const rowInk = Array.from({ length: height }, (_, y) => {
    let count = 0;
    for (let x = 1; x < width - 1; x += 1) {
      const alpha = rgba[(y * width + x) * 4 + 3]!;
      if (alpha >= 128 && Math.abs(luminanceAt(x, y) - background) >= 36) count += 1;
    }
    return count;
  });
  const active = rowInk.map((count) => count >= minimumRowInk);
  for (let y = 1; y < height - 1; y += 1) {
    if (!active[y] && active[y - 1] && active[y + 1]) active[y] = true;
  }
  const bands: Array<{ start: number; end: number; ink: number }> = [];
  for (let y = 0; y < height;) {
    if (!active[y]) {
      y += 1;
      continue;
    }
    const start = y;
    let ink = 0;
    while (y < height && active[y]) {
      ink += rowInk[y]!;
      y += 1;
    }
    bands.push({ start, end: y - 1, ink });
  }
  const reliable = bands.filter(({ start, end, ink }) => (
    end - start + 1 >= 2
    && end - start + 1 <= 48
    && ink >= Math.max(6, Math.round(width * 0.08))
  ));
  const nearest = reliable.reduce<(typeof reliable)[number] | null>((best, band) => {
    if (!best) return band;
    const distance = Math.abs((band.start + band.end) / 2 - anchorY);
    const bestDistance = Math.abs((best.start + best.end) / 2 - anchorY);
    return distance < bestDistance ? band : best;
  }, null);
  if (!nearest) return null;
  const bandHeight = nearest.end - nearest.start + 1;
  const centerY = (nearest.start + nearest.end) / 2;
  if (Math.abs(centerY - anchorY) > Math.max(12, bandHeight * 1.5)) return null;
  return {
    centerY,
    strokeWidth: Math.max(8, Math.min(64, bandHeight + Math.max(4, Math.round(bandHeight * 0.35)))),
  };
}

export const eraserRadiusFor = (imageWidth: number) => Math.max(10, Math.round(imageWidth / 48));

const squaredDistanceToSegment = (
  point: AnnotationPoint,
  start: AnnotationPoint,
  end: AnnotationPoint,
) => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) {
    return (point.x - start.x) ** 2 + (point.y - start.y) ** 2;
  }
  const position = Math.max(0, Math.min(1, (
    (point.x - start.x) * dx + (point.y - start.y) * dy
  ) / (dx * dx + dy * dy)));
  const closestX = start.x + dx * position;
  const closestY = start.y + dy * position;
  return (point.x - closestX) ** 2 + (point.y - closestY) ** 2;
};

const squaredDistanceToPath = (point: AnnotationPoint, path: AnnotationPoint[]) => {
  if (path.length === 1) return squaredDistanceToSegment(point, path[0]!, path[0]!);
  let closest = Number.POSITIVE_INFINITY;
  for (let index = 1; index < path.length; index += 1) {
    closest = Math.min(closest, squaredDistanceToSegment(point, path[index - 1]!, path[index]!));
  }
  return closest;
};

const cross = (first: AnnotationPoint, second: AnnotationPoint, third: AnnotationPoint) => (
  (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x)
);

export const highlighterOpacityFor = (
  opacity: HighlighterOpacity = DEFAULT_HIGHLIGHTER_OPACITY,
) => ({ soft: 0.18, regular: 0.3, strong: 0.45 })[opacity];

const segmentsIntersect = (
  firstStart: AnnotationPoint,
  firstEnd: AnnotationPoint,
  secondStart: AnnotationPoint,
  secondEnd: AnnotationPoint,
) => {
  const firstSideStart = cross(firstStart, firstEnd, secondStart);
  const firstSideEnd = cross(firstStart, firstEnd, secondEnd);
  const secondSideStart = cross(secondStart, secondEnd, firstStart);
  const secondSideEnd = cross(secondStart, secondEnd, firstEnd);
  const boxesOverlap = Math.max(Math.min(firstStart.x, firstEnd.x), Math.min(secondStart.x, secondEnd.x))
      <= Math.min(Math.max(firstStart.x, firstEnd.x), Math.max(secondStart.x, secondEnd.x))
    && Math.max(Math.min(firstStart.y, firstEnd.y), Math.min(secondStart.y, secondEnd.y))
      <= Math.min(Math.max(firstStart.y, firstEnd.y), Math.max(secondStart.y, secondEnd.y));
  return boxesOverlap && firstSideStart * firstSideEnd <= 0 && secondSideStart * secondSideEnd <= 0;
};

const squaredDistanceBetweenSegments = (
  firstStart: AnnotationPoint,
  firstEnd: AnnotationPoint,
  secondStart: AnnotationPoint,
  secondEnd: AnnotationPoint,
) => {
  if (segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd)) return 0;
  return Math.min(
    squaredDistanceToSegment(firstStart, secondStart, secondEnd),
    squaredDistanceToSegment(firstEnd, secondStart, secondEnd),
    squaredDistanceToSegment(secondStart, firstStart, firstEnd),
    squaredDistanceToSegment(secondEnd, firstStart, firstEnd),
  );
};

const squaredDistanceFromSegmentToPath = (
  start: AnnotationPoint,
  end: AnnotationPoint,
  path: AnnotationPoint[],
) => {
  if (path.length === 1) return squaredDistanceToSegment(path[0]!, start, end);
  let closest = Number.POSITIVE_INFINITY;
  for (let index = 1; index < path.length; index += 1) {
    closest = Math.min(closest, squaredDistanceBetweenSegments(
      start,
      end,
      path[index - 1]!,
      path[index]!,
    ));
  }
  return closest;
};

/**
 * Remove only Pencil/Highlighter ink touched by one eraser gesture.
 *
 * A crossed stroke becomes separate marks so the renderer never reconnects the
 * erased gap. Untouched marks retain their exact object and array identity; the
 * editor uses that no-op signal to avoid manufacturing an Undo step.
 */
export function eraseFreehandMarks(
  marks: Mark[],
  eraserPath: AnnotationPoint[],
  imageWidth: number,
): Mark[] {
  if (eraserPath.length === 0 || !eraserPath.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))) {
    return marks;
  }
  const eraserRadius = eraserRadiusFor(imageWidth);
  let changed = false;
  const next: Mark[] = [];
  for (const mark of marks) {
    if (mark.kind !== "pencil" && mark.kind !== "highlighter") {
      next.push(mark);
      continue;
    }
    const inkRadius = (mark.kind === "highlighter"
      ? highlighterWidthFor(mark, imageWidth)
      : strokeFor(imageWidth, mark.strokeWeight)) / 2;
    const thresholdSquared = (eraserRadius + inkRadius) ** 2;
    const erased = mark.points.map((point) => squaredDistanceToPath(point, eraserPath) <= thresholdSquared);
    for (let index = 1; index < mark.points.length; index += 1) {
      if (squaredDistanceFromSegmentToPath(
        mark.points[index - 1]!,
        mark.points[index]!,
        eraserPath,
      ) <= thresholdSquared) {
        erased[index - 1] = true;
        erased[index] = true;
      }
    }
    const runs: AnnotationPoint[][] = [];
    let run: AnnotationPoint[] = [];
    for (let index = 0; index < mark.points.length; index += 1) {
      const point = mark.points[index]!;
      if (!erased[index]) {
        run.push(point);
      } else if (run.length > 0) {
        runs.push(run);
        run = [];
      }
    }
    if (run.length > 0) runs.push(run);
    const fragments = runs
      .map((points): Extract<Mark, { kind: "pencil" | "highlighter" }> => ({ ...mark, points }))
      .filter((fragment) => !isDegenerate(fragment));
    if (fragments.length === 1 && fragments[0]!.points.length === mark.points.length) {
      next.push(mark);
      continue;
    }
    changed = true;
    next.push(...fragments);
  }
  return changed ? next : marks;
}

export type RectResizeHandle = "north-west" | "north-east" | "south-west" | "south-east";
export type ResizeHandle = RectResizeHandle | "start" | "end";

const handleRadiusFor = (imageWidth: number) => Math.max(8, imageWidth / 100);

export function resizeHandles(
  mark: Mark,
  imageWidth: number,
): Array<{ handle: ResizeHandle; x: number; y: number; radius: number }> {
  const radius = handleRadiusFor(imageWidth);
  if (mark.kind === "arrow" || mark.kind === "line") {
    return [
      { handle: "start", x: mark.x1, y: mark.y1, radius },
      { handle: "end", x: mark.x2, y: mark.y2, radius },
    ];
  }
  if (mark.kind === "text" || mark.kind === "counter" || mark.kind === "pencil" || mark.kind === "highlighter") return [];
  return [
    { handle: "north-west", x: mark.x, y: mark.y, radius },
    { handle: "north-east", x: mark.x + mark.w, y: mark.y, radius },
    { handle: "south-west", x: mark.x, y: mark.y + mark.h, radius },
    { handle: "south-east", x: mark.x + mark.w, y: mark.y + mark.h, radius },
  ];
}

export function hitResizeHandle(
  mark: Mark,
  x: number,
  y: number,
  imageWidth: number,
): ResizeHandle | null {
  for (const candidate of resizeHandles(mark, imageWidth)) {
    if (Math.hypot(x - candidate.x, y - candidate.y) <= candidate.radius * 1.35) {
      return candidate.handle;
    }
  }
  return null;
}

export function resizeMark(
  mark: Mark,
  handle: ResizeHandle,
  x: number,
  y: number,
): Mark {
  if (mark.kind === "arrow" || mark.kind === "line") {
    if (handle === "start") return { ...mark, x1: x, y1: y };
    if (handle === "end") return { ...mark, x2: x, y2: y };
    return mark;
  }
  if (
    mark.kind === "text" || mark.kind === "counter"
    || mark.kind === "pencil" || mark.kind === "highlighter"
    || handle === "start" || handle === "end"
  ) {
    return mark;
  }
  const opposite = {
    "north-west": { x: mark.x + mark.w, y: mark.y + mark.h },
    "north-east": { x: mark.x, y: mark.y + mark.h },
    "south-west": { x: mark.x + mark.w, y: mark.y },
    "south-east": { x: mark.x, y: mark.y },
  }[handle];
  return { ...mark, ...rectFrom(opposite.x, opposite.y, x, y) };
}

/**
 * Pixelate a region by downsampling it and drawing it back enlarged.
 *
 * A blur must not be reversible. A CSS/canvas gaussian blur is a filter over
 * pixels that are still present; averaging blocks *destroys* the detail, which
 * is what "baked into pixels" in 05 §3 requires — the region is unrecoverable
 * from the saved file.
 */
export function pixelate(
  ctx: AnnotationCanvasContext,
  x: number, y: number, w: number, h: number,
  block = 12,
) {
  if (w < 1 || h < 1) return;
  // Pointer coordinates are fractional after a Retina image is fitted into the
  // window. Canvas coerces getImageData sizes to integers, but our array math
  // would otherwise keep the fractions and index `undefined` pixels.
  const left = Math.floor(x);
  const top = Math.floor(y);
  const width = Math.max(1, Math.ceil(w));
  const height = Math.max(1, Math.ceil(h));
  const cols = Math.max(1, Math.round(width / block));
  const rows = Math.max(1, Math.round(height / block));
  const src = ctx.getImageData(left, top, width, height);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = Math.floor((c * width) / cols);
      const cy = Math.floor((r * height) / rows);
      const cw = Math.max(1, Math.floor(((c + 1) * width) / cols) - cx);
      const ch = Math.max(1, Math.floor(((r + 1) * height) / rows) - cy);

      let rs = 0, gs = 0, bs = 0, n = 0;
      for (let yy = cy; yy < cy + ch; yy++) {
        for (let xx = cx; xx < cx + cw; xx++) {
          const i = (yy * width + xx) * 4;
          rs += src.data[i]!; gs += src.data[i + 1]!; bs += src.data[i + 2]!; n++;
        }
      }
      ctx.fillStyle = `rgb(${Math.round(rs / n)},${Math.round(gs / n)},${Math.round(bs / n)})`;
      ctx.fillRect(left + cx, top + cy, cw, ch);
    }
  }
}

function boxBlurPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
) {
  const temporary = new Uint8ClampedArray(pixels.length);
  const rowPrefix = new Uint32Array((width + 1) * 4);
  for (let y = 0; y < height; y += 1) {
    rowPrefix.fill(0);
    for (let x = 0; x < width; x += 1) {
      const source = (y * width + x) * 4;
      const prefix = (x + 1) * 4;
      const previous = x * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        rowPrefix[prefix + channel] = rowPrefix[previous + channel]! + pixels[source + channel]!;
      }
    }
    for (let x = 0; x < width; x += 1) {
      const left = Math.max(0, x - radius);
      const right = Math.min(width, x + radius + 1);
      const count = right - left;
      const target = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const sum = rowPrefix[right * 4 + channel]! - rowPrefix[left * 4 + channel]!;
        temporary[target + channel] = Math.round(sum / count);
      }
    }
  }

  const columnPrefix = new Uint32Array((height + 1) * 4);
  for (let x = 0; x < width; x += 1) {
    columnPrefix.fill(0);
    for (let y = 0; y < height; y += 1) {
      const source = (y * width + x) * 4;
      const prefix = (y + 1) * 4;
      const previous = y * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        columnPrefix[prefix + channel] = columnPrefix[previous + channel]! + temporary[source + channel]!;
      }
    }
    for (let y = 0; y < height; y += 1) {
      const top = Math.max(0, y - radius);
      const bottom = Math.min(height, y + radius + 1);
      const count = bottom - top;
      const target = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const sum = columnPrefix[bottom * 4 + channel]! - columnPrefix[top * 4 + channel]!;
        pixels[target + channel] = Math.round(sum / count);
      }
    }
  }
}

const clampByte = (value: number) => Math.max(0, Math.min(255, value));

function destroyBlurDetail(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  block: number,
  seedX: number,
  seedY: number,
) {
  for (let top = 0; top < height; top += block) {
    for (let left = 0; left < width; left += block) {
      const right = Math.min(width, left + block);
      const bottom = Math.min(height, top + block);
      const sums = [0, 0, 0, 0];
      let count = 0;
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
          const offset = (y * width + x) * 4;
          for (let channel = 0; channel < 4; channel += 1) sums[channel]! += pixels[offset + channel]!;
          count += 1;
        }
      }
      const blockX = Math.floor(left / block);
      const blockY = Math.floor(top / block);
      const baseSeed = Math.imul(blockX + seedX + 1, 0x45d9f3b)
        ^ Math.imul(blockY + seedY + 1, 0x119de1f3);
      const color = sums.map((sum, channel) => {
        if (channel === 3) return Math.round(sum / count);
        const mixed = Math.imul(baseSeed ^ Math.imul(channel + 1, 0x27d4eb2d), 0x85ebca6b);
        const jitter = ((mixed >>> 24) % 33) - 16;
        return clampByte(Math.round((sum / count + jitter) / 32) * 32);
      });
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
          pixels.set(color, (y * width + x) * 4);
        }
      }
    }
  }
}

/**
 * Paints one baked blur region. Smooth mode is explicitly cosmetic. Secure
 * mode first destroys high-frequency detail into deterministic randomized,
 * quantized macro blocks, then softens those already-sanitized pixels. The
 * deterministic seed keeps editable project replay byte-stable.
 */
export function blurRegion(
  ctx: AnnotationCanvasContext,
  x: number,
  y: number,
  w: number,
  h: number,
  mode: BlurMode = DEFAULT_BLUR_MODE,
  strength: BlurStrength = DEFAULT_BLUR_STRENGTH,
) {
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const right = Math.min(ctx.canvas.width, Math.ceil(x + w));
  const bottom = Math.min(ctx.canvas.height, Math.ceil(y + h));
  const width = right - left;
  const height = bottom - top;
  if (width < 1 || height < 1) return;
  const image = ctx.getImageData(left, top, width, height);
  const parameters = blurStrengthParameters(width, height, strength);
  if (mode === "secure") {
    const block = parameters.secureBlock;
    destroyBlurDetail(image.data, width, height, block, left, top);
    boxBlurPixels(image.data, width, height, Math.max(2, Math.floor(block / 3)));
  } else {
    boxBlurPixels(image.data, width, height, parameters.smoothRadius);
  }
  ctx.putImageData(image, left, top);
}

export function blurStrengthParameters(
  width: number,
  height: number,
  strength: BlurStrength = DEFAULT_BLUR_STRENGTH,
) {
  const minimumSide = Math.max(1, Math.min(width, height));
  const regularSecureBlock = Math.max(8, Math.min(24, Math.round(minimumSide / 3)));
  const regularSmoothRadius = Math.max(2, Math.min(18, Math.round(minimumSide / 8)));
  const factor = strength === "soft" ? 0.75 : strength === "strong" ? 1.375 : 1;
  const smoothFactor = strength === "soft" ? 2 / 3 : strength === "strong" ? 1.5 : 1;
  return {
    secureBlock: Math.max(6, Math.min(33, Math.round(regularSecureBlock * factor))),
    smoothRadius: Math.max(2, Math.min(27, Math.round(regularSmoothRadius * smoothFactor))),
  };
}

/** Paint one mark. Blur reads pixels, so it must run against the composited canvas. */
export function paint(ctx: AnnotationCanvasContext, m: Mark, imageWidth: number) {
  const weight = "strokeWeight" in m ? m.strokeWeight : undefined;
  const stroke = strokeFor(imageWidth, weight);

  if (m.kind === "blur") return pixelate(ctx, m.x, m.y, m.w, m.h);
  if (m.kind === "blur_effect") {
    return blurRegion(
      ctx,
      m.x,
      m.y,
      m.w,
      m.h,
      m.blurMode ?? DEFAULT_BLUR_MODE,
      m.blurStrength ?? DEFAULT_BLUR_STRENGTH,
    );
  }

  if (m.kind === "spotlight") {
    const left = Math.max(0, Math.min(ctx.canvas.width, m.x));
    const top = Math.max(0, Math.min(ctx.canvas.height, m.y));
    const right = Math.max(0, Math.min(ctx.canvas.width, m.x + m.w));
    const bottom = Math.max(0, Math.min(ctx.canvas.height, m.y + m.h));
    ctx.save();
    ctx.fillStyle = `rgba(0,0,0,${spotlightOpacityFor(m.strength)})`;
    if (right <= left || bottom <= top) {
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    } else if ((m.spotlightShape ?? DEFAULT_SPOTLIGHT_SHAPE) === "rectangle") {
      ctx.fillRect(0, 0, ctx.canvas.width, top);
      ctx.fillRect(0, bottom, ctx.canvas.width, ctx.canvas.height - bottom);
      ctx.fillRect(0, top, left, bottom - top);
      ctx.fillRect(right, top, ctx.canvas.width - right, bottom - top);
    } else {
      const shape = m.spotlightShape ?? DEFAULT_SPOTLIGHT_SHAPE;
      const width = right - left;
      const height = bottom - top;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(ctx.canvas.width, 0);
      ctx.lineTo(ctx.canvas.width, ctx.canvas.height);
      ctx.lineTo(0, ctx.canvas.height);
      ctx.closePath();
      if (shape === "ellipse") {
        ctx.ellipse(
          left + width / 2,
          top + height / 2,
          width / 2,
          height / 2,
          0,
          0,
          Math.PI * 2,
        );
      } else {
        const radius = Math.min(width, height) * 0.22;
        ctx.moveTo(left + radius, top);
        ctx.lineTo(right - radius, top);
        ctx.quadraticCurveTo(right, top, right, top + radius);
        ctx.lineTo(right, bottom - radius);
        ctx.quadraticCurveTo(right, bottom, right - radius, bottom);
        ctx.lineTo(left + radius, bottom);
        ctx.quadraticCurveTo(left, bottom, left, bottom - radius);
        ctx.lineTo(left, top + radius);
        ctx.quadraticCurveTo(left, top, left + radius, top);
        ctx.closePath();
      }
      ctx.fill("evenodd");
    }
    ctx.restore();
    return;
  }

  ctx.strokeStyle = m.color;
  ctx.fillStyle = m.color;
  ctx.lineWidth = stroke;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.textAlign = "start";

  if (m.kind === "pencil" || m.kind === "highlighter") {
    const first = m.points[0];
    const last = m.points.at(-1);
    if (!first || !last) return;
    ctx.save();
    ctx.lineWidth = m.kind === "highlighter"
      ? highlighterWidthFor(m, imageWidth)
      : stroke;
    if (m.kind === "highlighter") ctx.globalAlpha = highlighterOpacityFor(m.highlighterOpacity);
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (let index = 1; index < m.points.length - 1; index += 1) {
      const current = m.points[index]!;
      const next = m.points[index + 1]!;
      ctx.quadraticCurveTo(current.x, current.y, (current.x + next.x) / 2, (current.y + next.y) / 2);
    }
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (m.kind === "box") {
    if (m.filled) {
      ctx.save();
      ctx.globalAlpha = 0.18;
      ctx.fillRect(m.x, m.y, m.w, m.h);
      ctx.restore();
    }
    ctx.strokeRect(m.x, m.y, m.w, m.h);
    return;
  }

  if (m.kind === "ellipse") {
    ctx.beginPath();
    ctx.ellipse(m.x + m.w / 2, m.y + m.h / 2, m.w / 2, m.h / 2, 0, 0, Math.PI * 2);
    if (m.filled) {
      ctx.save();
      ctx.globalAlpha = 0.18;
      ctx.fill();
      ctx.restore();
    }
    ctx.stroke();
    return;
  }

  if (m.kind === "text") {
    const layout = textLayout(m);
    ctx.font = layout.font;
    ctx.textBaseline = "top";
    if (layout.style === "boxed") {
      ctx.fillStyle = m.color;
      ctx.fillRect(layout.background.x, layout.background.y, layout.background.w, layout.background.h);
      ctx.fillStyle = "rgba(255,255,255,0.96)";
      ctx.fillText(m.text, m.x, m.y);
      return;
    }
    if (layout.style === "rounded-boxed") {
      const box = layout.background;
      const radius = Math.min(box.radius, box.w / 2, box.h / 2);
      ctx.fillStyle = m.color;
      ctx.beginPath();
      ctx.moveTo(box.x + radius, box.y);
      ctx.lineTo(box.x + box.w - radius, box.y);
      ctx.quadraticCurveTo(box.x + box.w, box.y, box.x + box.w, box.y + radius);
      ctx.lineTo(box.x + box.w, box.y + box.h - radius);
      ctx.quadraticCurveTo(box.x + box.w, box.y + box.h, box.x + box.w - radius, box.y + box.h);
      ctx.lineTo(box.x + radius, box.y + box.h);
      ctx.quadraticCurveTo(box.x, box.y + box.h, box.x, box.y + box.h - radius);
      ctx.lineTo(box.x, box.y + radius);
      ctx.quadraticCurveTo(box.x, box.y, box.x + radius, box.y);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.96)";
      ctx.fillText(m.text, m.x, m.y);
      return;
    }
    if (layout.style === "monospaced-boxed") {
      ctx.fillStyle = "rgba(255,255,255,0.96)";
      ctx.fillRect(layout.background.x, layout.background.y, layout.background.w, layout.background.h);
      ctx.strokeStyle = m.color;
      ctx.lineWidth = Math.max(2, m.size / 10);
      ctx.strokeRect(layout.background.x, layout.background.y, layout.background.w, layout.background.h);
      ctx.fillStyle = m.color;
      ctx.fillText(m.text, m.x, m.y);
      return;
    }
    if (layout.style === "outlined") {
      ctx.lineWidth = Math.max(3, m.size / 5);
      ctx.strokeStyle = m.color;
      ctx.fillStyle = "rgba(255,255,255,0.96)";
      ctx.strokeText(m.text, m.x, m.y);
      ctx.fillText(m.text, m.x, m.y);
      return;
    }
    // Plain text retains the original white halo so old flattened output stays
    // unchanged while Rounded and Monospaced alter only their font family.
    ctx.lineWidth = Math.max(2, m.size / 8);
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.strokeText(m.text, m.x, m.y);
    ctx.fillStyle = m.color;
    ctx.fillText(m.text, m.x, m.y);
    return;
  }

  if (m.kind === "counter") {
    const counterStyle = m.counterStyle ?? DEFAULT_COUNTER_STYLE;
    ctx.save();
    if (counterStyle !== "plain") {
      ctx.beginPath();
      ctx.arc(m.x, m.y, m.size / 2, 0, Math.PI * 2);
      if (counterStyle === "filled") {
        ctx.fill();
      } else {
        ctx.lineWidth = Math.max(2, m.size / 10);
        ctx.stroke();
      }
    }
    ctx.fillStyle = counterStyle === "filled" ? "rgba(255,255,255,0.96)" : m.color;
    ctx.font = `${counterStyle === "plain" ? 820 : 750} ${Math.round(m.size * (counterStyle === "plain" ? 0.72 : 0.56))}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (counterStyle === "plain") {
      ctx.lineWidth = Math.max(2, m.size / 9);
      ctx.strokeStyle = "rgba(255,255,255,0.92)";
      ctx.strokeText(String(m.value), m.x, m.y);
    }
    ctx.fillText(String(m.value), m.x, m.y);
    ctx.restore();
    return;
  }

  if (m.kind === "line") {
    ctx.beginPath();
    ctx.moveTo(m.x1, m.y1);
    ctx.lineTo(m.x2, m.y2);
    ctx.stroke();
    return;
  }

  // Arrow styles share endpoints and resize semantics. The curve is a real
  // quadratic path; the others differ only in their heads, so changing style
  // never moves the user's geometry.
  const arrowStyle = m.arrowStyle ?? DEFAULT_ARROW_STYLE;
  const head = stroke * 4;
  const control = arrowStyle === "curved" ? arrowCurveControl(m) : null;
  const endAngle = control
    ? Math.atan2(m.y2 - control.y, m.x2 - control.x)
    : Math.atan2(m.y2 - m.y1, m.x2 - m.x1);
  const shaftEnd = arrowStyle === "classic"
    ? {
        x: m.x2 - Math.cos(endAngle) * head * 0.6,
        y: m.y2 - Math.sin(endAngle) * head * 0.6,
      }
    : { x: m.x2, y: m.y2 };

  ctx.beginPath();
  ctx.moveTo(m.x1, m.y1);
  if (control) ctx.quadraticCurveTo(control.x, control.y, m.x2, m.y2);
  else ctx.lineTo(shaftEnd.x, shaftEnd.y);
  ctx.stroke();

  const paintHead = (x: number, y: number, angle: number, filled: boolean) => {
    const left = {
      x: x - Math.cos(angle - Math.PI / 7) * head,
      y: y - Math.sin(angle - Math.PI / 7) * head,
    };
    const right = {
      x: x - Math.cos(angle + Math.PI / 7) * head,
      y: y - Math.sin(angle + Math.PI / 7) * head,
    };
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(left.x, left.y);
    if (filled) {
      ctx.lineTo(right.x, right.y);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.moveTo(x, y);
      ctx.lineTo(right.x, right.y);
      ctx.stroke();
    }
  };

  paintHead(m.x2, m.y2, endAngle, arrowStyle !== "open");
  if (arrowStyle === "double") {
    paintHead(m.x1, m.y1, endAngle + Math.PI, true);
  }
}

/**
 * Paint every mark onto a context: destructive pixelation, then the spotlight
 * mask, then foreground annotations, with counters always last.
 *
 * Order matters and is not cosmetic: pixelation samples whatever is already on
 * the canvas, so a blur painted after an arrow would consume the arrow. The
 * spotlight must dim the protected screenshot but stay behind labels and shapes.
 */
export function paintAll(ctx: AnnotationCanvasContext, marks: Mark[], imageWidth: number) {
  for (const m of marks) if (m.kind === "blur" || m.kind === "blur_effect") paint(ctx, m, imageWidth);
  for (const m of marks) if (m.kind === "spotlight") paint(ctx, m, imageWidth);
  for (const m of marks) {
    if (m.kind !== "blur" && m.kind !== "blur_effect" && m.kind !== "spotlight" && m.kind !== "counter") {
      paint(ctx, m, imageWidth);
    }
  }
  for (const m of marks) if (m.kind === "counter") paint(ctx, m, imageWidth);
}

/**
 * The dashed ring around the selected mark.
 *
 * Deliberately *not* part of `paintAll`: it is editor chrome, not annotation. It
 * must never reach the flattened image, so `save` repaints without it — which is
 * only possible because the two are separate calls.
 */
export function paintSelection(ctx: AnnotationCanvasContext, m: Mark, imageWidth: number) {
  const b = boundsOf(m, imageWidth);
  ctx.save();
  ctx.strokeStyle = annotateInk.ringLight!;
  ctx.lineWidth = Math.max(1, strokeFor(imageWidth) / 2);
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(b.x, b.y, b.w, b.h);
  // Doubled in near-black on the offset dashes so the ring survives on a white
  // screenshot as well as a dark one — a selection has to be visible on anything.
  ctx.strokeStyle = annotateInk.ringDark!;
  ctx.lineDashOffset = 6;
  ctx.strokeRect(b.x, b.y, b.w, b.h);
  ctx.setLineDash([]);
  for (const handle of resizeHandles(m, imageWidth)) {
    ctx.fillStyle = annotateInk.ringLight!;
    ctx.strokeStyle = annotateInk.ringDark!;
    ctx.lineWidth = Math.max(1, strokeFor(imageWidth) / 2);
    ctx.beginPath();
    ctx.arc(handle.x, handle.y, handle.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/** Whether saving these marks removed information the OCR text still remembers. */
export const redacts = (marks: Mark[]) => marks.some((m) =>
  m.kind === "blur" || (m.kind === "blur_effect" && (m.blurMode ?? DEFAULT_BLUR_MODE) === "secure")
);
