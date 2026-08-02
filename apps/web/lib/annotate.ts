/**
 * The drawing model for the quick annotation editor (05 §3).
 *
 * Kept apart from the React component so the geometry — which is where the bugs
 * live — can be exercised under plain node. The component owns pointers and
 * canvases; this file owns what a mark *is* and how it is painted.
 *
 * Scope is deliberately four tools. 04's tripwire list names "full annotation
 * suite (highlighter, crop, counter, emoji)" as a trap that eats the build
 * window, and the spec is explicit: nothing else in MVP.
 */

import { annotate as annotateInk } from "@capso/shared/tokens";

export type Tool = "arrow" | "box" | "text" | "blur";

/**
 * Red default plus four, per 05 §3 — a preset palette, not a colour picker.
 * Read from the brand tokens rather than written here: `pnpm brand:check` fails
 * the build on a hex literal in source, and it is right to.
 */
export const PALETTE = [
  annotateInk.red!, annotateInk.amber!, annotateInk.green!, annotateInk.blue!, annotateInk.purple!,
] as const;
export const DEFAULT_COLOR = PALETTE[0];

export type Mark =
  | { kind: "arrow"; color: string; x1: number; y1: number; x2: number; y2: number }
  | { kind: "box"; color: string; x: number; y: number; w: number; h: number }
  | { kind: "text"; color: string; x: number; y: number; text: string; size: number }
  | { kind: "blur"; x: number; y: number; w: number; h: number };

/** Stroke width and text size scale with the image so a mark reads the same on a
 *  1600px capture as on a 600px one. */
export const strokeFor = (imageWidth: number) => Math.max(2, Math.round(imageWidth / 320));
export const textSizeFor = (imageWidth: number) => Math.max(14, Math.round(imageWidth / 40));

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

/** Every number a mark carries, for the finite check below. */
const coordsOf = (m: Mark): number[] =>
  m.kind === "arrow" ? [m.x1, m.y1, m.x2, m.y2]
  : m.kind === "text" ? [m.x, m.y, m.size]
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
  return (m.kind === "box" || m.kind === "blur") ? m.w < 4 || m.h < 4
    : m.kind === "arrow" ? Math.hypot(m.x2 - m.x1, m.y2 - m.y1) < 6
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
  const pad = strokeFor(imageWidth) * 2;
  if (m.kind === "box" || m.kind === "blur") {
    return { x: m.x - pad, y: m.y - pad, w: m.w + pad * 2, h: m.h + pad * 2 };
  }
  if (m.kind === "text") {
    return { x: m.x - pad, y: m.y - pad, w: m.text.length * m.size * 0.6 + pad * 2, h: m.size + pad * 2 };
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
  if (m.kind === "arrow") return { ...m, x1: m.x1 + dx, y1: m.y1 + dy, x2: m.x2 + dx, y2: m.y2 + dy };
  return { ...m, x: m.x + dx, y: m.y + dy };
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
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  block = 12,
) {
  if (w < 1 || h < 1) return;
  const cols = Math.max(1, Math.round(w / block));
  const rows = Math.max(1, Math.round(h / block));
  const src = ctx.getImageData(x, y, w, h);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = Math.floor((c * w) / cols);
      const cy = Math.floor((r * h) / rows);
      const cw = Math.max(1, Math.floor(((c + 1) * w) / cols) - cx);
      const ch = Math.max(1, Math.floor(((r + 1) * h) / rows) - cy);

      let rs = 0, gs = 0, bs = 0, n = 0;
      for (let yy = cy; yy < cy + ch; yy++) {
        for (let xx = cx; xx < cx + cw; xx++) {
          const i = (yy * w + xx) * 4;
          rs += src.data[i]!; gs += src.data[i + 1]!; bs += src.data[i + 2]!; n++;
        }
      }
      ctx.fillStyle = `rgb(${Math.round(rs / n)},${Math.round(gs / n)},${Math.round(bs / n)})`;
      ctx.fillRect(x + cx, y + cy, cw, ch);
    }
  }
}

/** Paint one mark. Blur reads pixels, so it must run against the composited canvas. */
export function paint(ctx: CanvasRenderingContext2D, m: Mark, imageWidth: number) {
  const stroke = strokeFor(imageWidth);

  if (m.kind === "blur") return pixelate(ctx, m.x, m.y, m.w, m.h);

  ctx.strokeStyle = m.color;
  ctx.fillStyle = m.color;
  ctx.lineWidth = stroke;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (m.kind === "box") {
    ctx.strokeRect(m.x, m.y, m.w, m.h);
    return;
  }

  if (m.kind === "text") {
    ctx.font = `600 ${m.size}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textBaseline = "top";
    // A label has to stay legible over whatever it lands on, and screenshots are
    // mostly light with dark text on them. An outline costs nothing and removes
    // the whole class of "my red note vanished into a red button".
    ctx.lineWidth = Math.max(2, m.size / 8);
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.strokeText(m.text, m.x, m.y);
    ctx.fillText(m.text, m.x, m.y);
    return;
  }

  // Arrow: shaft, then a filled head sized off the stroke so it stays in
  // proportion at any image size.
  const head = stroke * 4;
  const angle = Math.atan2(m.y2 - m.y1, m.x2 - m.x1);
  const backX = m.x2 - Math.cos(angle) * head * 0.6;
  const backY = m.y2 - Math.sin(angle) * head * 0.6;

  ctx.beginPath();
  ctx.moveTo(m.x1, m.y1);
  ctx.lineTo(backX, backY);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(m.x2, m.y2);
  ctx.lineTo(m.x2 - Math.cos(angle - Math.PI / 7) * head, m.y2 - Math.sin(angle - Math.PI / 7) * head);
  ctx.lineTo(m.x2 - Math.cos(angle + Math.PI / 7) * head, m.y2 - Math.sin(angle + Math.PI / 7) * head);
  ctx.closePath();
  ctx.fill();
}

/**
 * Paint every mark onto a context, blurs first.
 *
 * Order matters and is not cosmetic: pixelation samples whatever is already on
 * the canvas, so a blur painted after an arrow would smear the arrow into the
 * region and — worse — a blur drawn under a label would consume the label. Blurs
 * redact the underlying screenshot; everything else annotates on top of it.
 */
export function paintAll(ctx: CanvasRenderingContext2D, marks: Mark[], imageWidth: number) {
  for (const m of marks) if (m.kind === "blur") paint(ctx, m, imageWidth);
  for (const m of marks) if (m.kind !== "blur") paint(ctx, m, imageWidth);
}

/**
 * The dashed ring around the selected mark.
 *
 * Deliberately *not* part of `paintAll`: it is editor chrome, not annotation. It
 * must never reach the flattened image, so `save` repaints without it — which is
 * only possible because the two are separate calls.
 */
export function paintSelection(ctx: CanvasRenderingContext2D, m: Mark, imageWidth: number) {
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
  ctx.restore();
}

/** Whether saving these marks removed information the OCR text still remembers. */
export const redacts = (marks: Mark[]) => marks.some((m) => m.kind === "blur");
