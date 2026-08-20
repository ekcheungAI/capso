import assert from "node:assert/strict";
import test from "node:test";

/**
 * Smoke test for the capture path — the first automated check this extension has
 * ever had.
 *
 * It exists because `capture.js` shipped calling `contentHash(...)` while only
 * *re-exporting* that name (`export { x } from "./y"` does not bind `x` locally),
 * so every capture threw `ReferenceError: contentHash is not defined`. Nothing
 * caught it: `pnpm lint` only covers `apps/web`, there were no tests here, and
 * the extension has never been loaded in a real Chrome.
 *
 * The point is therefore not to assert a clever property. It is to *execute the
 * capture path at all*, so a name that does not resolve, or a promise that
 * rejects, fails a command someone runs rather than a browser nobody opened.
 *
 * The browser APIs an MV3 worker gets for free are stubbed just enough to let the
 * real code run: this checks our logic, not Chrome's.
 */

const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** A bitmap large enough that `fitWithin` actually has to scale it down. */
let scriptMetrics;
let stabilizedMetrics;
let scrollingMetrics;
let capturedViewports;
let restoredPage;
let canvasDraws;
let areaSelection;
let elementSelection;

function installBrowserStubs() {
  scriptMetrics = {
    originalX: 0,
    originalY: 240,
    width: 1200,
    height: 1800,
    viewportWidth: 1200,
    viewportHeight: 900,
  };
  stabilizedMetrics = null;
  scrollingMetrics = null;
  capturedViewports = 0;
  restoredPage = false;
  canvasDraws = [];
  areaSelection = {
    x: 120,
    y: 100,
    width: 300,
    height: 200,
    viewportWidth: 1200,
    viewportHeight: 900,
  };
  elementSelection = {
    x: 80,
    y: 60,
    width: 420,
    height: 240,
    viewportWidth: 1200,
    viewportHeight: 900,
    kind: "element",
  };
  globalThis.createImageBitmap = async () => ({
    width: 3200,
    height: 1800,
    close() {},
  });

  globalThis.OffscreenCanvas = class {
    constructor(width, height) {
      this.width = width;
      this.height = height;
    }
    getContext() {
      return {
        fillStyle: "",
        fillRect() {},
        drawImage(...args) {
          canvasDraws.push(args);
        },
      };
    }
    async convertToBlob({ type }) {
      // Content differs per size so the hash is not trivially constant.
      return new Blob([`fake-${type}-${this.width}x${this.height}`], { type });
    }
  };

  // Present in an MV3 service worker, absent from Node. Stubbed rather than the
  // code changed: `compress` reads blobs the way the worker actually can.
  globalThis.FileReader = class {
    readAsDataURL(blob) {
      blob
        .arrayBuffer()
        .then((buf) => {
          this.result = `data:${blob.type};base64,${Buffer.from(buf).toString("base64")}`;
          this.onload?.();
        })
        .catch((err) => {
          this.error = err;
          this.onerror?.();
        });
    }
  };

  globalThis.chrome = {
    tabs: {
      query: async () => [{ id: 1, windowId: 7, url: "https://example.com/pricing", title: "Pricing" }],
      captureVisibleTab: async () => {
        capturedViewports++;
        return PNG_1PX;
      },
    },
    scripting: {
      executeScript: async ({ func, args = [] }) => {
        if (func.name === "prepareFullPageDocument") return [{ result: scriptMetrics }];
        if (func.name === "stabilizeFullPageDocument") {
          return [{ result: stabilizedMetrics ?? { ...scriptMetrics, stable: true } }];
        }
        if (func.name === "selectCaptureArea") return [{ result: areaSelection }];
        if (func.name === "selectCaptureElement") return [{ result: elementSelection }];
        if (func.name === "scrollFullPageDocument") {
          const live = scrollingMetrics ?? stabilizedMetrics ?? scriptMetrics;
          return [{
            result: {
              x: args[0],
              y: args[1],
              width: live.width,
              height: live.height,
              viewportWidth: live.viewportWidth,
              viewportHeight: live.viewportHeight,
            },
          }];
        }
        if (func.name === "restoreFullPageDocument") {
          restoredPage = true;
          return [{ result: null }];
        }
        throw new Error(`unexpected injected function ${func.name}`);
      },
    },
  };
}

installBrowserStubs();
const {
  captureArea,
  captureElement,
  captureFullPage,
  captureVisibleTab,
  compress,
  contentHash,
  cropSourceRect,
  fullPageTileOffsets,
} = await import("./capture.js");

test("a capture completes and carries every field the ingest contract requires", async () => {
  const res = await captureVisibleTab();
  // Surfaced rather than asserted bare: when this regresses, the message is the
  // reason, and a bare `assert.ok(res.ok)` would hide it.
  assert.equal(res.ok, true, `capture failed: ${res.message}`);

  const c = res.capture;
  assert.equal(c.source, "extension");
  assert.equal(c.pageUrl, "https://example.com/pricing");
  assert.equal(c.pageTitle, "Pricing");
  assert.equal(c.sourceApp, "example.com", "hostname is what the provenance badge reads");
  assert.match(c.imageDataUrl, /^data:/);
  assert.match(c.imageDataUrl, /^data:image\/jpeg;base64,/);
  assert.match(c.thumbDataUrl, /^data:image\/webp;base64,/);
  assert.match(c.contentHash, /^[0-9a-f]{64}$/, "sha-256 hex");
  assert.ok(c.width > 0 && c.height > 0);
});

test("the capture is shrunk to the shared spec's cap, not sent at source size", async () => {
  // 3200x1800 in, long edge capped at 1600 — the reason this compresses at all is
  // Vercel's 4.5 MB body limit (see compress()).
  const { width, height, thumbDataUrl } = await compress(PNG_1PX);
  assert.equal(width, 1600);
  assert.equal(height, 900);
  assert.match(thumbDataUrl, /^data:image\/webp;base64,/);
});

test("contentHash is callable from this module, not merely re-exported", async () => {
  // The regression itself. A re-export satisfies `import { contentHash }` in a
  // *consumer* while leaving the name unbound inside `capture.js`, so this passing
  // is not sufficient — the first test above is what proves the internal call
  // resolves. Kept because it names the distinction.
  assert.equal(typeof contentHash, "function");
  assert.match(await contentHash("abc"), /^[0-9a-f]{64}$/);
});

test("full-page offsets cover the final partial viewport exactly once", () => {
  assert.deepEqual(fullPageTileOffsets(1800, 900), [0, 900]);
  assert.deepEqual(fullPageTileOffsets(1750, 900), [0, 850]);
  assert.deepEqual(fullPageTileOffsets(600, 900), [0]);
});

test("area crop maps CSS pixels to the exact bounded retina source rectangle", () => {
  assert.deepEqual(cropSourceRect(areaSelection, 3200, 1800), {
    x: 320,
    y: 200,
    width: 800,
    height: 400,
  });
  assert.deepEqual(cropSourceRect({
    ...areaSelection,
    x: 1100,
    width: 300,
  }, 3200, 1800), {
    x: 2933,
    y: 200,
    width: 267,
    height: 400,
  });
});

test("a selected browser area is cropped only after selection and encoded for exact ingest", async () => {
  capturedViewports = 0;
  canvasDraws = [];
  const res = await captureArea();

  assert.equal(res.ok, true, `capture failed: ${res.message}`);
  assert.equal(capturedViewports, 1);
  assert.equal(res.capture.width, 800);
  assert.equal(res.capture.height, 400);
  assert.match(res.capture.imageDataUrl, /^data:image\/jpeg;base64,/);
  assert.match(res.capture.thumbDataUrl, /^data:image\/webp;base64,/);
  assert.match(res.capture.contentHash, /^[0-9a-f]{64}$/);
  assert.match(res.label, /selected area/);
  assert.ok(canvasDraws.some((draw) => draw.length === 9), "retina crop uses source and destination rectangles");
});

test("Escape or a click-sized area cancels silently before any screenshot is taken", async () => {
  areaSelection = null;
  capturedViewports = 0;
  const res = await captureArea();

  assert.equal(res.ok, false);
  assert.equal(res.cancelled, true);
  assert.equal(capturedViewports, 0);
});

test("a DOM element selection crops its exact Retina box through the normal ingest contract", async () => {
  capturedViewports = 0;
  canvasDraws = [];
  const res = await captureElement();

  assert.equal(res.ok, true, `element capture failed: ${res.message}`);
  assert.equal(capturedViewports, 1);
  assert.equal(res.capture.width, 1120);
  assert.equal(res.capture.height, 480);
  assert.match(res.capture.imageDataUrl, /^data:image\/jpeg;base64,/);
  assert.match(res.capture.contentHash, /^[0-9a-f]{64}$/);
  assert.match(res.label, /page element/);
  assert.ok(canvasDraws.some((draw) => draw.length === 9));
});

test("a full-page capture stitches bounded tiles, restores scroll and carries exact ingest metadata", async () => {
  installBrowserStubs();
  capturedViewports = 0;
  restoredPage = false;
  canvasDraws = [];
  const res = await captureFullPage();
  assert.equal(res.ok, true, `capture failed: ${res.message}`);
  assert.equal(capturedViewports, 2);
  assert.equal(restoredPage, true);
  assert.ok(canvasDraws.length >= 2, "each viewport is drawn into the bounded output canvas");
  assert.equal(res.capture.width, 1200);
  assert.equal(res.capture.height, 1800);
  assert.match(res.capture.imageDataUrl, /^data:image\/jpeg;base64,/);
  assert.match(res.capture.thumbDataUrl, /^data:image\/webp;base64,/);
  assert.match(res.capture.contentHash, /^[0-9a-f]{64}$/);
  assert.match(res.label, /full page/);
});

test("full-page capture warms bounded lazy content before sizing its final canvas", async () => {
  installBrowserStubs();
  stabilizedMetrics = {
    ...scriptMetrics,
    height: 2700,
    stable: true,
  };
  capturedViewports = 0;
  restoredPage = false;

  const res = await captureFullPage();
  assert.equal(res.ok, true, `capture failed: ${res.message}`);
  assert.equal(capturedViewports, 3);
  assert.equal(res.capture.width, 1200);
  assert.equal(res.capture.height, 2700);
  assert.equal(restoredPage, true);
});

test("full-page capture fails closed when layout geometry drifts after warm-up", async () => {
  installBrowserStubs();
  stabilizedMetrics = { ...scriptMetrics, stable: true };
  scrollingMetrics = { ...scriptMetrics, height: 1900 };
  capturedViewports = 0;
  restoredPage = false;

  const res = await captureFullPage();
  assert.equal(res.ok, false);
  assert.match(res.message, /layout changed/i);
  assert.equal(capturedViewports, 0, "drift is rejected before a partial image is captured");
  assert.equal(restoredPage, true);
});

test("full-page capture refuses a page that never settles during bounded warm-up", async () => {
  installBrowserStubs();
  stabilizedMetrics = { ...scriptMetrics, height: 2100, stable: false };
  capturedViewports = 0;
  restoredPage = false;

  const res = await captureFullPage();
  assert.equal(res.ok, false);
  assert.match(res.message, /kept changing/i);
  assert.equal(capturedViewports, 0);
  assert.equal(restoredPage, true);
});

test("an overlong page is refused without taking a partial image and still restores the page", async () => {
  installBrowserStubs();
  scriptMetrics = {
    ...scriptMetrics,
    height: 28_000,
    viewportHeight: 800,
  };
  capturedViewports = 0;
  restoredPage = false;

  const res = await captureFullPage();
  assert.equal(res.ok, false);
  assert.match(res.message, /safe limit is 30/);
  assert.equal(capturedViewports, 0);
  assert.equal(restoredPage, true);
});

test("a blocked scheme is refused before Chrome is asked", async () => {
  globalThis.chrome.tabs.query = async () => [{ id: 1, url: "chrome://extensions", title: "x" }];
  globalThis.chrome.tabs.captureVisibleTab = async () => {
    throw new Error("should never be called for a blocked scheme");
  };
  const res = await captureVisibleTab();
  assert.equal(res.ok, false);
  assert.match(res.message, /chrome: pages/);
});
