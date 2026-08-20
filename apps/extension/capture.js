// Geometry and encoding come from the one shared spec, mirrored here by
// `pnpm capture:spec` because this extension has no bundler. These used to be
// two local constants whose only tie to the web app's was a comment saying they
// matched — see packages/shared/src/capture.ts.
import {
  contentHash,
  FULL_QUALITY,
  FULL_TYPE,
  fitWithin,
  THUMB_EDGE,
  THUMB_QUALITY,
  THUMB_TYPE,
} from "./capture-spec.generated.js";
import { capturePixel } from "./tokens.generated.js";

/**
 * Imported *and* re-exported. `export { contentHash } from "./…"` alone forwards
 * the binding to consumers without introducing it into this module's scope, so
 * `captureVisibleTab` below threw `ReferenceError` on every capture while the
 * background worker's own import looked perfectly healthy.
 */
export { contentHash };

/**
 * Shrink and re-encode before it ever reaches the wire.
 *
 * `captureVisibleTab` returns an uncompressed retina PNG — measured at ~4.2 MB,
 * which is ~5.6 MB once base64-encoded and therefore over Vercel's 4.5 MB
 * request-body limit. `OffscreenCanvas` is available in an MV3 service worker;
 * note `convertToBlob`, since workers have no `toDataURL`.
 *
 * Returns the encoded data URL *and* its true pixel size, because the web app
 * uses width/height to reserve layout before the image decodes and had been
 * receiving null for every extension capture.
 */
async function dataUrl(blob) {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function encode(source, maxEdge, type, quality) {
  const { width, height } = fitWithin(source.width, source.height, maxEdge);
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d").drawImage(source, 0, 0, width, height);
  return {
    dataUrl: await dataUrl(await canvas.convertToBlob({ type, quality })),
    width,
    height,
  };
}

async function encodeCaptureSource(source) {
  const [original, thumb] = await Promise.all([
    encode(source, undefined, FULL_TYPE, FULL_QUALITY),
    encode(source, THUMB_EDGE, THUMB_TYPE, THUMB_QUALITY),
  ]);
  return {
    dataUrl: original.dataUrl,
    thumbDataUrl: thumb.dataUrl,
    width: original.width,
    height: original.height,
  };
}

export async function compress(dataUrlValue) {
  const source = await createImageBitmap(await (await fetch(dataUrlValue)).blob());
  try {
    return await encodeCaptureSource(source);
  } finally {
    source.close();
  }
}

/** Upgrade captures queued by an older extension before direct delivery. */
export async function thumbnail(dataUrlValue) {
  const source = await createImageBitmap(await (await fetch(dataUrlValue)).blob());
  try {
    return (await encode(source, THUMB_EDGE, THUMB_TYPE, THUMB_QUALITY)).dataUrl;
  } finally {
    source.close();
  }
}

/** Schemes `captureVisibleTab` refuses by policy — there is nothing to attempt there. */
const BLOCKED = ["chrome", "edge", "about", "devtools", "view-source", "chrome-extension"];
const FULL_PAGE_MAX_WIDTH = 1600;
const FULL_PAGE_MAX_HEIGHT = 12000;
const FULL_PAGE_MAX_TILES = 30;
const FULL_PAGE_MAX_BYTES = Math.floor(2.25 * 1024 * 1024);
const CAPTURE_INTERVAL_MS = 600;

export function fullPageTileOffsets(total, viewport) {
  if (!Number.isFinite(total) || !Number.isFinite(viewport) || total <= 0 || viewport <= 0) {
    throw new Error("The page reported invalid capture dimensions.");
  }
  const last = Math.max(0, Math.ceil(total - viewport));
  const offsets = [];
  for (let offset = 0; offset < last; offset += viewport) offsets.push(offset);
  offsets.push(last);
  return [...new Set(offsets)];
}

export function fullPageMetricsMatch(expected, actual) {
  return ["width", "height", "viewportWidth", "viewportHeight"].every((key) => (
    Number.isFinite(expected?.[key])
    && Number.isFinite(actual?.[key])
    && expected[key] > 0
    && actual[key] > 0
    && expected[key] === actual[key]
  ));
}

// These functions are serialized by chrome.scripting.executeScript, so they
// must be self-contained and receive every value through `args`.
function prepareFullPageDocument(sessionId) {
  const root = document.documentElement;
  const body = document.body;
  const style = document.createElement("style");
  style.id = `capso-full-page-capture-style-${sessionId}`;
  style.textContent = `
    html, body { scroll-behavior: auto !important; scroll-snap-type: none !important; }
    html::-webkit-scrollbar, body::-webkit-scrollbar { display: none !important; }
    [data-capso-capture-session="${sessionId}"][data-capso-capture-hide="true"] { visibility: hidden !important; }
  `;
  document.getElementById(style.id)?.remove();
  root.appendChild(style);

  for (const element of document.querySelectorAll("body *")) {
    const position = getComputedStyle(element).position;
    if (position === "fixed") {
      element.setAttribute("data-capso-capture-session", sessionId);
      element.setAttribute("data-capso-capture-fixed", "true");
    }
    if (position === "sticky") {
      element.setAttribute("data-capso-capture-session", sessionId);
      element.setAttribute("data-capso-capture-sticky", "true");
      element.setAttribute(
        "data-capso-capture-original-top",
        String(Math.round(element.getBoundingClientRect().top + window.scrollY)),
      );
    }
  }

  return {
    originalX: window.scrollX,
    originalY: window.scrollY,
    width: Math.max(root.scrollWidth, body?.scrollWidth ?? 0, window.innerWidth),
    height: Math.max(root.scrollHeight, body?.scrollHeight ?? 0, window.innerHeight),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  };
}

async function stabilizeFullPageDocument(sessionId, maxTiles) {
  const root = document.documentElement;
  const body = document.body;
  const measure = () => ({
    width: Math.max(root.scrollWidth, body?.scrollWidth ?? 0, window.innerWidth),
    height: Math.max(root.scrollHeight, body?.scrollHeight ?? 0, window.innerHeight),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  });
  const waitForLayout = async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await new Promise((resolve) => setTimeout(resolve, 120));
  };
  const markNewPositionedElements = () => {
    for (const element of document.querySelectorAll(
      `body *:not([data-capso-capture-session])`,
    )) {
      const position = getComputedStyle(element).position;
      if (position !== "fixed" && position !== "sticky") continue;
      element.setAttribute("data-capso-capture-session", sessionId);
      if (position === "fixed") {
        element.setAttribute("data-capso-capture-fixed", "true");
      } else {
        element.setAttribute("data-capso-capture-sticky", "true");
        element.setAttribute(
          "data-capso-capture-original-top",
          String(Math.round(element.getBoundingClientRect().top + window.scrollY)),
        );
      }
    }
  };
  const valid = (metrics) => [
    metrics.width,
    metrics.height,
    metrics.viewportWidth,
    metrics.viewportHeight,
  ].every((value) => Number.isFinite(value) && value > 0);

  let previous = measure();
  for (let pass = 0; pass < 2; pass++) {
    if (!valid(previous)) return { ...previous, stable: false };
    const tileCount = Math.ceil(previous.width / previous.viewportWidth)
      * Math.ceil(previous.height / previous.viewportHeight);
    if (tileCount > maxTiles) return { ...previous, stable: true };

    const last = Math.max(0, Math.ceil(previous.height - previous.viewportHeight));
    const offsets = [];
    for (let y = 0; y < last; y += previous.viewportHeight) offsets.push(y);
    offsets.push(last);
    for (const y of [...new Set(offsets)]) {
      window.scrollTo(0, y);
      await waitForLayout();
      markNewPositionedElements();
    }
    await waitForLayout();

    const current = measure();
    if (
      valid(current)
      && current.width === previous.width
      && current.height === previous.height
      && current.viewportWidth === previous.viewportWidth
      && current.viewportHeight === previous.viewportHeight
    ) {
      return { ...current, stable: true };
    }
    previous = current;
  }
  return { ...previous, stable: false };
}

async function scrollFullPageDocument(x, y, sessionId) {
  window.scrollTo(x, y);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await new Promise((resolve) => setTimeout(resolve, 80));
  const actualX = window.scrollX;
  const actualY = window.scrollY;
  for (const element of document.querySelectorAll(
    `[data-capso-capture-session="${sessionId}"]`,
  )) {
    const fixed = element.hasAttribute("data-capso-capture-fixed");
    const originalTop = Number(element.getAttribute("data-capso-capture-original-top"));
    const alreadyCapturedSticky =
      element.hasAttribute("data-capso-capture-sticky") &&
      Number.isFinite(originalTop) &&
      originalTop < actualY;
    element.setAttribute(
      "data-capso-capture-hide",
      String((fixed && (actualX > 0 || actualY > 0)) || alreadyCapturedSticky),
    );
  }
  return {
    x: actualX,
    y: actualY,
    width: Math.max(
      document.documentElement.scrollWidth,
      document.body?.scrollWidth ?? 0,
      window.innerWidth,
    ),
    height: Math.max(
      document.documentElement.scrollHeight,
      document.body?.scrollHeight ?? 0,
      window.innerHeight,
    ),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  };
}

function restoreFullPageDocument(x, y, sessionId) {
  document.getElementById(`capso-full-page-capture-style-${sessionId}`)?.remove();
  for (const element of document.querySelectorAll(
    `[data-capso-capture-session="${sessionId}"]`,
  )) {
    element.removeAttribute("data-capso-capture-session");
    element.removeAttribute("data-capso-capture-fixed");
    element.removeAttribute("data-capso-capture-sticky");
    element.removeAttribute("data-capso-capture-original-top");
    element.removeAttribute("data-capso-capture-hide");
  }
  window.scrollTo(x, y);
}

export async function selectCaptureArea() {
  return await new Promise((resolve) => {
    const host = document.createElement("div");
    host.setAttribute("data-capso-area-capture", crypto.randomUUID());
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;cursor:crosshair;";
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .veil { position: fixed; inset: 0; background: rgba(10, 10, 12, .28); cursor: crosshair; user-select: none; touch-action: none; }
      .box { position: fixed; display: none; border: 1px solid white; background: rgba(255,255,255,.08); box-shadow: 0 0 0 99999px rgba(10,10,12,.42), 0 0 0 1px rgba(0,0,0,.45); }
      .hint { position: fixed; top: 18px; left: 50%; transform: translateX(-50%); padding: 7px 10px; border-radius: 999px; background: rgba(20,20,22,.9); color: white; font: 500 12px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,.22); }
    `;
    const veil = document.createElement("div");
    veil.className = "veil";
    const box = document.createElement("div");
    box.className = "box";
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "Drag to capture · Esc to cancel";
    shadow.append(style, veil, box, hint);
    document.documentElement.appendChild(host);

    let start = null;
    let pointerId = null;
    const rectFrom = (x, y) => ({
      x: Math.min(start.x, x),
      y: Math.min(start.y, y),
      width: Math.abs(x - start.x),
      height: Math.abs(y - start.y),
    });
    const draw = (rect) => {
      box.style.display = "block";
      box.style.left = `${rect.x}px`;
      box.style.top = `${rect.y}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
    };
    const cleanup = () => {
      document.removeEventListener("keydown", onKeyDown, true);
      host.remove();
    };
    const finish = async (rect) => {
      cleanup();
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      resolve(rect);
    };
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void finish(null);
    };
    document.addEventListener("keydown", onKeyDown, true);
    veil.addEventListener("contextmenu", (event) => event.preventDefault());
    veil.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || pointerId !== null) return;
      pointerId = event.pointerId;
      start = { x: event.clientX, y: event.clientY };
      veil.setPointerCapture(pointerId);
      draw(rectFrom(event.clientX, event.clientY));
    });
    veil.addEventListener("pointermove", (event) => {
      if (event.pointerId !== pointerId || !start) return;
      draw(rectFrom(event.clientX, event.clientY));
    });
    veil.addEventListener("pointerup", (event) => {
      if (event.pointerId !== pointerId || !start) return;
      const rect = rectFrom(event.clientX, event.clientY);
      pointerId = null;
      start = null;
      void finish(rect.width >= 2 && rect.height >= 2 ? {
        ...rect,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      } : null);
    });
  });
}

/**
 * Prefer the smallest visible DOM element beneath the pointer. A pointer drag
 * always switches to ordinary free-area selection, so an uncertain snap can
 * never trap the user or silently choose a different rectangle.
 */
export async function selectCaptureElement() {
  return await new Promise((resolve) => {
    const host = document.createElement("div");
    host.setAttribute("data-capso-element-capture", crypto.randomUUID());
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;cursor:crosshair;";
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .veil { position: fixed; inset: 0; background: rgba(10,10,12,.18); cursor: crosshair; user-select: none; touch-action: none; }
      .box { position: fixed; display: none; border: 2px solid rgb(255,255,255); background: rgba(255,255,255,.08); box-shadow: 0 0 0 1px rgba(0,0,0,.52), 0 8px 28px rgba(0,0,0,.2); pointer-events: none; }
      .size { position: absolute; top: 6px; left: 6px; padding: 4px 6px; border-radius: 5px; background: rgba(20,20,22,.9); color: white; font: 600 11px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; white-space: nowrap; }
      .hint { position: fixed; top: 18px; left: 50%; transform: translateX(-50%); padding: 7px 10px; border-radius: 999px; background: rgba(20,20,22,.92); color: white; font: 500 12px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,.22); }
    `;
    const veil = document.createElement("div");
    veil.className = "veil";
    const box = document.createElement("div");
    box.className = "box";
    const size = document.createElement("span");
    size.className = "size";
    box.appendChild(size);
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "Click an element · Drag for a free area · Esc cancels";
    shadow.append(style, veil, box, hint);
    document.documentElement.appendChild(host);

    let hovered = null;
    let pressed = null;
    let start = null;
    let pointerId = null;
    let dragging = false;

    const boundedRect = (rect, kind = "element") => {
      const x = Math.max(0, Math.min(window.innerWidth, rect.left));
      const y = Math.max(0, Math.min(window.innerHeight, rect.top));
      const right = Math.max(x, Math.min(window.innerWidth, rect.right));
      const bottom = Math.max(y, Math.min(window.innerHeight, rect.bottom));
      return { x, y, width: right - x, height: bottom - y, kind };
    };
    const candidateAt = (x, y) => {
      for (const element of document.elementsFromPoint(x, y)) {
        if (
          element === host ||
          element === document.documentElement ||
          element === document.body ||
          ["SCRIPT", "STYLE", "LINK", "META"].includes(element.tagName)
        ) continue;
        const computed = getComputedStyle(element);
        if (computed.visibility === "hidden" || Number(computed.opacity) === 0) continue;
        const candidate = boundedRect(element.getBoundingClientRect());
        if (candidate.width < 16 || candidate.height < 12) continue;
        if (
          candidate.width >= window.innerWidth * 0.985 &&
          candidate.height >= window.innerHeight * 0.985
        ) continue;
        return candidate;
      }
      return null;
    };
    const freeRect = (x, y) => ({
      x: Math.min(start.x, x),
      y: Math.min(start.y, y),
      width: Math.abs(x - start.x),
      height: Math.abs(y - start.y),
      kind: "area",
    });
    const draw = (rect, label) => {
      if (!rect) {
        box.style.display = "none";
        return;
      }
      box.style.display = "block";
      box.style.left = `${rect.x}px`;
      box.style.top = `${rect.y}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
      size.textContent = `${label} · ${Math.round(rect.width)} × ${Math.round(rect.height)}`;
    };
    const cleanup = () => {
      document.removeEventListener("keydown", onKeyDown, true);
      host.remove();
    };
    const finish = async (rect) => {
      cleanup();
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      resolve(rect && rect.width >= 2 && rect.height >= 2 ? {
        ...rect,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      } : null);
    };
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void finish(null);
    };
    const updateHover = (event) => {
      hovered = candidateAt(event.clientX, event.clientY);
      draw(hovered, "Element");
    };

    document.addEventListener("keydown", onKeyDown, true);
    veil.addEventListener("contextmenu", (event) => event.preventDefault());
    veil.addEventListener("pointermove", (event) => {
      if (event.pointerId !== pointerId || !start) {
        updateHover(event);
        return;
      }
      const rect = freeRect(event.clientX, event.clientY);
      if (!dragging && (rect.width >= 4 || rect.height >= 4)) dragging = true;
      if (dragging) draw(rect, "Free area");
    });
    veil.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || pointerId !== null) return;
      pointerId = event.pointerId;
      start = { x: event.clientX, y: event.clientY };
      pressed = hovered ?? candidateAt(event.clientX, event.clientY);
      dragging = false;
      veil.setPointerCapture(pointerId);
    });
    veil.addEventListener("pointerup", (event) => {
      if (event.pointerId !== pointerId || !start) return;
      const rect = dragging
        ? freeRect(event.clientX, event.clientY)
        : candidateAt(event.clientX, event.clientY) ?? pressed;
      pointerId = null;
      start = null;
      pressed = null;
      dragging = false;
      if (rect) void finish(rect);
      else {
        hint.textContent = "No clear element here · Drag for a free area · Esc cancels";
        draw(null);
      }
    });
    veil.addEventListener("pointercancel", (event) => {
      if (event.pointerId !== pointerId) return;
      pointerId = null;
      start = null;
      pressed = null;
      dragging = false;
      hovered = null;
      hint.textContent = "Pointer cancelled · Try again or press Esc";
      draw(null);
    });
  });
}

export function cropSourceRect(selection, bitmapWidth, bitmapHeight) {
  if (
    !selection ||
    ![selection.x, selection.y, selection.width, selection.height,
      selection.viewportWidth, selection.viewportHeight, bitmapWidth, bitmapHeight]
      .every((value) => Number.isFinite(value)) ||
    selection.width < 2 || selection.height < 2 ||
    selection.viewportWidth <= 0 || selection.viewportHeight <= 0 ||
    bitmapWidth <= 0 || bitmapHeight <= 0
  ) {
    throw new Error("The selected area is invalid.");
  }
  const scaleX = bitmapWidth / selection.viewportWidth;
  const scaleY = bitmapHeight / selection.viewportHeight;
  const x = Math.max(0, Math.min(bitmapWidth - 1, Math.round(selection.x * scaleX)));
  const y = Math.max(0, Math.min(bitmapHeight - 1, Math.round(selection.y * scaleY)));
  return {
    x,
    y,
    width: Math.max(1, Math.min(bitmapWidth - x, Math.round(selection.width * scaleX))),
    height: Math.max(1, Math.min(bitmapHeight - y, Math.round(selection.height * scaleY))),
  };
}

async function fullPageBlob(canvas) {
  let current = canvas;
  for (let scalePass = 0; scalePass < 4; scalePass++) {
    for (const quality of [0.82, 0.72, 0.62, 0.52]) {
      const blob = await current.convertToBlob({ type: FULL_TYPE, quality });
      if (blob.size <= FULL_PAGE_MAX_BYTES) return { blob, canvas: current };
    }
    const next = new OffscreenCanvas(
      Math.max(1, Math.round(current.width * 0.82)),
      Math.max(1, Math.round(current.height * 0.82)),
    );
    next.getContext("2d").drawImage(current, 0, 0, next.width, next.height);
    current = next;
  }
  throw new Error("The full-page image is too large to store safely.");
}

async function encodeFullPage(canvas) {
  const original = await fullPageBlob(canvas);
  const thumb = await encode(original.canvas, THUMB_EDGE, THUMB_TYPE, THUMB_QUALITY);
  return {
    dataUrl: await dataUrl(original.blob),
    thumbDataUrl: thumb.dataUrl,
    width: original.canvas.width,
    height: original.canvas.height,
  };
}

function captureMetadata(tab, encoded) {
  let host;
  try {
    host = tab.url ? new URL(tab.url).hostname : undefined;
  } catch {
    host = undefined;
  }
  return {
    imageDataUrl: encoded.dataUrl,
    thumbDataUrl: encoded.thumbDataUrl,
    width: encoded.width,
    height: encoded.height,
    source: "extension",
    pageUrl: tab.url,
    pageTitle: tab.title ?? "",
    sourceApp: host,
  };
}

function blockedCapture(tab) {
  if (!tab?.id) return "No active tab.";
  const scheme = tab.url?.match(/^([a-z-]+):/i)?.[1]?.toLowerCase();
  return scheme && BLOCKED.includes(scheme)
    ? `Chrome won't allow capture on ${scheme}: pages. Switch to an ordinary tab and try again.`
    : null;
}

/**
 * Grab the visible viewport of the active tab.
 *
 * Returns `{ ok: false, message }` rather than throwing, so every caller reports
 * the same way. A tab whose URL cannot be read is *not* refused — that means
 * activeTab has not been granted yet, not that capture is blocked, and Chrome's
 * own error is more accurate than our guess.
 */
export async function captureVisibleTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const blocked = blockedCapture(tab);
  if (blocked) return { ok: false, message: blocked };

  let raw;
  try {
    raw = await chrome.tabs.captureVisibleTab({ format: "png" });
  } catch (err) {
    return { ok: false, message: err?.message ?? "Capture failed." };
  }

  // A compress failure used to fall through and post the raw ~5.5 MB base64 PNG
  // with a comment saying the app would downscale it on receipt. It cannot: that
  // body is over Vercel's limit and the request never lands. Failing here keeps
  // the capture recoverable instead of sending something guaranteed to be lost.
  let shrunk;
  try {
    shrunk = await compress(raw);
  } catch (err) {
    return { ok: false, message: `Could not encode the capture (${err?.message ?? "unknown"}).` };
  }

  const capture = captureMetadata(tab, shrunk);
  return {
    ok: true,
    capture: {
      ...capture,
      contentHash: await contentHash(shrunk.dataUrl),
    },
    label: tab.title || tab.url || "Capture",
  };
}

async function captureViewportSelection(tab, selector, selectionName) {
  let selection;
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: selector,
    });
    selection = result?.[0]?.result;
  } catch (error) {
    return {
      ok: false,
      message: `Could not select ${selectionName} on this page (${error?.message ?? "blocked"}).`,
    };
  }
  if (!selection) return { ok: false, cancelled: true, message: "Capture cancelled." };

  try {
    const raw = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    const bitmap = await createImageBitmap(await (await fetch(raw)).blob());
    try {
      const source = cropSourceRect(selection, bitmap.width, bitmap.height);
      const canvas = new OffscreenCanvas(source.width, source.height);
      canvas.getContext("2d").drawImage(
        bitmap,
        source.x,
        source.y,
        source.width,
        source.height,
        0,
        0,
        source.width,
        source.height,
      );
      const encoded = await encodeCaptureSource(canvas);
      const capture = captureMetadata(tab, encoded);
      return {
        ok: true,
        capture: {
          ...capture,
          contentHash: await contentHash(encoded.dataUrl),
        },
        label: `${tab.title || tab.url || "Page"} · ${selection.kind === "area" ? "selected area" : selectionName}`,
      };
    } finally {
      bitmap.close();
    }
  } catch (error) {
    return { ok: false, message: `Selection capture failed (${error?.message ?? "unknown"}).` };
  }
}

/** Select a CSS-pixel rectangle, remove the overlay, then crop the Retina tile. */
export async function captureArea() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const blocked = blockedCapture(tab);
  if (blocked) return { ok: false, message: blocked };
  return captureViewportSelection(tab, selectCaptureArea, "selected area");
}

/** Snap to a visible DOM element; any deliberate drag falls back to free Area. */
export async function captureElement() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const blocked = blockedCapture(tab);
  if (blocked) return { ok: false, message: blocked };
  return captureViewportSelection(tab, selectCaptureElement, "page element");
}

/**
 * Capture a scrollable page without ever allocating its retina-sized whole.
 * Each viewport tile is drawn directly into a bounded output canvas. Chrome
 * documents a hard maximum of two captureVisibleTab calls per second, hence the
 * 600 ms spacing. The original scroll position and temporary page attributes
 * are restored in `finally`, including every failure path.
 */
export async function captureFullPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const blocked = blockedCapture(tab);
  if (blocked) return { ok: false, message: blocked };

  const sessionId = crypto.randomUUID();
  let metrics;
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: prepareFullPageDocument,
      args: [sessionId],
    });
    metrics = result?.[0]?.result;
  } catch (error) {
    return { ok: false, message: `Could not inspect this page (${error?.message ?? "blocked"}).` };
  }
  if (
    !metrics ||
    ![metrics.width, metrics.height, metrics.viewportWidth, metrics.viewportHeight]
      .every((value) => Number.isFinite(value) && value > 0)
  ) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: restoreFullPageDocument,
        args: [metrics?.originalX ?? 0, metrics?.originalY ?? 0, sessionId],
      });
    } catch {
      // The page may have navigated while its dimensions were being read.
    }
    return { ok: false, message: "This page reported invalid capture dimensions." };
  }

  try {
    let xOffsets = fullPageTileOffsets(metrics.width, metrics.viewportWidth);
    let yOffsets = fullPageTileOffsets(metrics.height, metrics.viewportHeight);
    if (xOffsets.length * yOffsets.length > FULL_PAGE_MAX_TILES) {
      return {
        ok: false,
        message: `This page needs ${xOffsets.length * yOffsets.length} capture tiles; Capso's safe limit is ${FULL_PAGE_MAX_TILES}.`,
      };
    }

    const stabilizationResult = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: stabilizeFullPageDocument,
      args: [sessionId, FULL_PAGE_MAX_TILES],
    });
    const stabilized = stabilizationResult?.[0]?.result;
    if (!stabilized?.stable || !fullPageMetricsMatch(stabilized, stabilized)) {
      return {
        ok: false,
        message: "This page kept changing during Capso's bounded warm-up. Wait for it to finish loading and try again.",
      };
    }
    metrics = {
      ...metrics,
      width: stabilized.width,
      height: stabilized.height,
      viewportWidth: stabilized.viewportWidth,
      viewportHeight: stabilized.viewportHeight,
    };
    xOffsets = fullPageTileOffsets(metrics.width, metrics.viewportWidth);
    yOffsets = fullPageTileOffsets(metrics.height, metrics.viewportHeight);
    if (xOffsets.length * yOffsets.length > FULL_PAGE_MAX_TILES) {
      return {
        ok: false,
        message: `This page needs ${xOffsets.length * yOffsets.length} capture tiles after loading; Capso's safe limit is ${FULL_PAGE_MAX_TILES}.`,
      };
    }

    const scale = Math.min(
      1,
      FULL_PAGE_MAX_WIDTH / metrics.width,
      FULL_PAGE_MAX_HEIGHT / metrics.height,
    );
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(metrics.width * scale)),
      Math.max(1, Math.round(metrics.height * scale)),
    );
    const context = canvas.getContext("2d");
    context.fillStyle = capturePixel.jpegBackground;
    context.fillRect(0, 0, canvas.width, canvas.height);

    let captured = 0;
    for (const y of yOffsets) {
      for (const x of xOffsets) {
        const positionResult = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: scrollFullPageDocument,
          args: [x, y, sessionId],
        });
        const position = positionResult?.[0]?.result;
        if (!position) throw new Error("The page stopped responding while scrolling.");
        if (!fullPageMetricsMatch(metrics, position)) {
          throw new Error(
            "The page layout changed while Capso was capturing it. Wait for the page to finish loading and try again.",
          );
        }
        if (captured > 0) await new Promise((resolve) => setTimeout(resolve, CAPTURE_INTERVAL_MS));
        const raw = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        const bitmap = await createImageBitmap(await (await fetch(raw)).blob());
        try {
          const remainingWidth = Math.min(position.viewportWidth, metrics.width - position.x);
          const remainingHeight = Math.min(position.viewportHeight, metrics.height - position.y);
          const sourceWidth = Math.max(
            1,
            Math.round(remainingWidth * bitmap.width / position.viewportWidth),
          );
          const sourceHeight = Math.max(
            1,
            Math.round(remainingHeight * bitmap.height / position.viewportHeight),
          );
          context.drawImage(
            bitmap,
            0,
            0,
            sourceWidth,
            sourceHeight,
            Math.round(position.x * scale),
            Math.round(position.y * scale),
            Math.max(1, Math.round(remainingWidth * scale)),
            Math.max(1, Math.round(remainingHeight * scale)),
          );
        } finally {
          bitmap.close();
        }
        captured++;
      }
    }

    const encoded = await encodeFullPage(canvas);
    const capture = captureMetadata(tab, encoded);
    return {
      ok: true,
      capture: {
        ...capture,
        contentHash: await contentHash(encoded.dataUrl),
      },
      label: `${tab.title || tab.url || "Page"} · full page`,
    };
  } catch (error) {
    return { ok: false, message: `Full-page capture failed (${error?.message ?? "unknown"}).` };
  } finally {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: restoreFullPageDocument,
        args: [metrics.originalX, metrics.originalY, sessionId],
      });
    } catch {
      // The tab may have navigated or closed. There is nothing left to restore.
    }
  }
}
