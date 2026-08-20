export const AREA_ASPECT_RATIOS = ["free", "1:1", "4:3", "16:9"] as const;

export type AreaAspectRatio = (typeof AREA_ASPECT_RATIOS)[number];

export type AreaPoint = { x: number; y: number };

export type AreaSelection = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type AreaViewport = {
  width: number;
  height: number;
  scaleFactor: number;
};

export type VisualAnalysis = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

export function magnifierPosition(
  pointer: AreaPoint,
  viewportInput: AreaViewport,
  size = 120,
  gap = 20,
): AreaPoint {
  const viewport = safeViewport(viewportInput);
  const safeSize = clamp(finite(size), 1, Math.min(viewport.width, viewport.height));
  const safeGap = Math.max(0, finite(gap));
  const px = clamp(finite(pointer.x), 0, viewport.width);
  const py = clamp(finite(pointer.y), 0, viewport.height);
  const preferredX = px + safeGap + safeSize <= viewport.width
    ? px + safeGap
    : px - safeGap - safeSize;
  const preferredY = py + safeGap + safeSize <= viewport.height
    ? py + safeGap
    : py - safeGap - safeSize;
  return {
    x: clamp(preferredX, 0, viewport.width - safeSize),
    y: clamp(preferredY, 0, viewport.height - safeSize),
  };
}

export function shouldHandleSelectionKey(tagName: string, key: string) {
  if (key === "Escape") return true;
  return !["INPUT", "SELECT", "BUTTON", "TEXTAREA"].includes(tagName.toUpperCase());
}

const ratioValue = (ratio: AreaAspectRatio): number | null => {
  if (ratio === "free") return null;
  const [width, height] = ratio.split(":").map(Number);
  return width! / height!;
};

const finite = (value: number) => Number.isFinite(value) ? value : 0;
const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));

function safeViewport(viewport: AreaViewport) {
  return {
    width: Math.max(1, finite(viewport.width)),
    height: Math.max(1, finite(viewport.height)),
    scaleFactor: clamp(finite(viewport.scaleFactor), 0.5, 5),
  };
}

function pixelDistance(data: Uint8ClampedArray, left: number, right: number) {
  const a = left * 4;
  const b = right * 4;
  return Math.max(
    Math.abs(data[a]! - data[b]!),
    Math.abs(data[a + 1]! - data[b + 1]!),
    Math.abs(data[a + 2]! - data[b + 2]!),
  );
}

/**
 * Finds only flat, bounded, strongly separated UI surfaces. This deliberately
 * refuses photography, text glyphs, weak edges and near-fullscreen regions;
 * free drag remains the authoritative fallback for every uncertain pixel set.
 */
export function detectVisualRect(
  analysis: VisualAnalysis,
  pointer: AreaPoint,
  viewportInput: AreaViewport,
): AreaSelection | null {
  const width = Math.floor(analysis.width);
  const height = Math.floor(analysis.height);
  const total = width * height;
  if (
    !Number.isFinite(analysis.width) ||
    !Number.isFinite(analysis.height) ||
    width < 16 ||
    height < 12 ||
    total > 1_500_000 ||
    analysis.data.length !== total * 4
  ) return null;

  const viewport = safeViewport(viewportInput);
  const scaleX = width / viewport.width;
  const scaleY = height / viewport.height;
  const seedX = clamp(Math.floor(finite(pointer.x) * scaleX), 0, width - 1);
  const seedY = clamp(Math.floor(finite(pointer.y) * scaleY), 0, height - 1);
  const seed = seedY * width + seedX;
  const maxVisited = Math.min(total, 80_000);
  const visited = new Uint8Array(total);
  const queue = new Int32Array(maxVisited);
  let head = 0;
  let tail = 1;
  let count = 0;
  let minX = seedX;
  let maxX = seedX;
  let minY = seedY;
  let maxY = seedY;
  visited[seed] = 1;
  queue[0] = seed;

  const enqueue = (index: number) => {
    if (visited[index]) return true;
    visited[index] = 1;
    if (pixelDistance(analysis.data, seed, index) > 18) return true;
    if (tail >= maxVisited) return false;
    queue[tail++] = index;
    return true;
  };

  while (head < tail) {
    const index = queue[head++]!;
    const x = index % width;
    const y = Math.floor(index / width);
    count++;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    if (x > 0 && !enqueue(index - 1)) return null;
    if (x + 1 < width && !enqueue(index + 1)) return null;
    if (y > 0 && !enqueue(index - width)) return null;
    if (y + 1 < height && !enqueue(index + width)) return null;
  }

  const componentWidth = maxX - minX + 1;
  const componentHeight = maxY - minY + 1;
  const componentArea = componentWidth * componentHeight;
  if (
    componentWidth < 10 ||
    componentHeight < 8 ||
    count < 48 ||
    count / componentArea < 0.58 ||
    minX === 0 ||
    minY === 0 ||
    maxX + 1 >= width ||
    maxY + 1 >= height
  ) return null;

  const samples = 9;
  const supported = (side: "left" | "right" | "top" | "bottom") => {
    let strong = 0;
    for (let sample = 1; sample <= samples; sample++) {
      const progress = sample / (samples + 1);
      if (side === "left" || side === "right") {
        const y = Math.round(minY + (componentHeight - 1) * progress);
        const insideX = side === "left" ? minX : maxX;
        const outsideX = side === "left" ? minX - 1 : maxX + 1;
        if (pixelDistance(analysis.data, y * width + insideX, y * width + outsideX) >= 36) {
          strong++;
        }
      } else {
        const x = Math.round(minX + (componentWidth - 1) * progress);
        const insideY = side === "top" ? minY : maxY;
        const outsideY = side === "top" ? minY - 1 : maxY + 1;
        if (pixelDistance(analysis.data, insideY * width + x, outsideY * width + x) >= 36) {
          strong++;
        }
      }
    }
    return strong >= 6;
  };
  if (!["left", "right", "top", "bottom"].every((side) => supported(side as "left" | "right" | "top" | "bottom"))) {
    return null;
  }

  const x = (minX - 1) / scaleX;
  const y = (minY - 1) / scaleY;
  const selectionWidth = (componentWidth + 2) / scaleX;
  const selectionHeight = (componentHeight + 2) / scaleY;
  if (
    selectionWidth < 16 ||
    selectionHeight < 12 ||
    selectionWidth * selectionHeight > viewport.width * viewport.height * 0.9 ||
    (selectionWidth > viewport.width * 0.985 && selectionHeight > viewport.height * 0.985)
  ) return null;
  const roundedWidth = clamp(Math.round(selectionWidth), 2, viewport.width);
  const roundedHeight = clamp(Math.round(selectionHeight), 2, viewport.height);
  return {
    x: clamp(Math.round(x), 0, viewport.width - roundedWidth),
    y: clamp(Math.round(y), 0, viewport.height - roundedHeight),
    width: roundedWidth,
    height: roundedHeight,
  };
}

export function selectionFromDrag(
  anchor: AreaPoint,
  pointer: AreaPoint,
  viewportInput: AreaViewport,
  ratio: AreaAspectRatio,
): AreaSelection {
  const viewport = safeViewport(viewportInput);
  const ax = clamp(finite(anchor.x), 0, viewport.width);
  const ay = clamp(finite(anchor.y), 0, viewport.height);
  const px = clamp(finite(pointer.x), 0, viewport.width);
  const py = clamp(finite(pointer.y), 0, viewport.height);
  let width = Math.abs(px - ax);
  let height = Math.abs(py - ay);
  const locked = ratioValue(ratio);
  if (locked && width > 0 && height > 0) {
    if (width / height > locked) width = Math.round(height * locked);
    else height = Math.round(width / locked);
  }
  width = clamp(width, 0, viewport.width);
  height = clamp(height, 0, viewport.height);
  const x = px < ax ? ax - width : ax;
  const y = py < ay ? ay - height : ay;
  return {
    x: clamp(x, 0, viewport.width - width),
    y: clamp(y, 0, viewport.height - height),
    width,
    height,
  };
}

export function selectionPixelSize(selection: AreaSelection, scaleFactor: number) {
  const scale = clamp(finite(scaleFactor), 0.5, 5);
  return {
    width: Math.max(1, Math.round(selection.width * scale)),
    height: Math.max(1, Math.round(selection.height * scale)),
  };
}

export function applyExactPixelSize(
  selection: AreaSelection,
  axis: "width" | "height",
  requestedPixels: number,
  viewportInput: AreaViewport,
  ratio: AreaAspectRatio,
): AreaSelection {
  const viewport = safeViewport(viewportInput);
  const requested = Math.max(2, Math.round(finite(requestedPixels)));
  let width = axis === "width" ? requested / viewport.scaleFactor : selection.width;
  let height = axis === "height" ? requested / viewport.scaleFactor : selection.height;
  const locked = ratioValue(ratio);
  if (locked) {
    if (axis === "width") height = width / locked;
    else width = height * locked;
  }
  const fit = Math.min(1, viewport.width / width, viewport.height / height);
  width = Math.round(width * fit * viewport.scaleFactor) / viewport.scaleFactor;
  height = Math.round(height * fit * viewport.scaleFactor) / viewport.scaleFactor;
  width = clamp(width, 1 / viewport.scaleFactor, viewport.width);
  height = clamp(height, 1 / viewport.scaleFactor, viewport.height);
  return {
    x: clamp(selection.x, 0, viewport.width - width),
    y: clamp(selection.y, 0, viewport.height - height),
    width,
    height,
  };
}

export function nudgeSelection(
  selection: AreaSelection,
  dxPixels: number,
  dyPixels: number,
  viewportInput: AreaViewport,
): AreaSelection {
  const viewport = safeViewport(viewportInput);
  return {
    ...selection,
    x: clamp(selection.x + finite(dxPixels) / viewport.scaleFactor, 0, viewport.width - selection.width),
    y: clamp(selection.y + finite(dyPixels) / viewport.scaleFactor, 0, viewport.height - selection.height),
  };
}
