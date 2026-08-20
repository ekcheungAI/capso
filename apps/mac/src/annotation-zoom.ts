export type CanvasZoomDirection = "in" | "out";

export const CANVAS_ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;

type CanvasSize = { width: number; height: number };

function isPositiveFinite(value: number) {
  return Number.isFinite(value) && value > 0;
}

export function fitCanvasSize(
  availableWidth: number,
  availableHeight: number,
  imageWidth: number,
  imageHeight: number,
): CanvasSize {
  if (![availableWidth, availableHeight, imageWidth, imageHeight].every(isPositiveFinite)) {
    return { width: 1, height: 1 };
  }
  const scale = Math.min(1, availableWidth / imageWidth, availableHeight / imageHeight);
  return { width: imageWidth * scale, height: imageHeight * scale };
}

export function canvasZoomStep(current: number, direction: CanvasZoomDirection) {
  if (direction === "in") {
    return CANVAS_ZOOM_STEPS.find((step) => step > current + Number.EPSILON)
      ?? CANVAS_ZOOM_STEPS.at(-1)!;
  }
  return [...CANVAS_ZOOM_STEPS].reverse().find((step) => step < current - Number.EPSILON)
    ?? CANVAS_ZOOM_STEPS[0];
}

export function zoomedCanvasSize(fit: CanvasSize, zoom: number): CanvasSize {
  const safeZoom = isPositiveFinite(zoom) ? zoom : 1;
  return { width: fit.width * safeZoom, height: fit.height * safeZoom };
}
