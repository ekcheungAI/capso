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
function installBrowserStubs() {
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
      return { drawImage() {} };
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
      query: async () => [{ id: 1, url: "https://example.com/pricing", title: "Pricing" }],
      captureVisibleTab: async () => PNG_1PX,
    },
  };
}

installBrowserStubs();
const { captureVisibleTab, compress, contentHash } = await import("./capture.js");

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
  assert.match(c.contentHash, /^[0-9a-f]{64}$/, "sha-256 hex");
  assert.ok(c.width > 0 && c.height > 0);
});

test("the capture is shrunk to the shared spec's cap, not sent at source size", async () => {
  // 3200x1800 in, long edge capped at 1600 — the reason this compresses at all is
  // Vercel's 4.5 MB body limit (see compress()).
  const { width, height } = await compress(PNG_1PX);
  assert.equal(width, 1600);
  assert.equal(height, 900);
});

test("contentHash is callable from this module, not merely re-exported", async () => {
  // The regression itself. A re-export satisfies `import { contentHash }` in a
  // *consumer* while leaving the name unbound inside `capture.js`, so this passing
  // is not sufficient — the first test above is what proves the internal call
  // resolves. Kept because it names the distinction.
  assert.equal(typeof contentHash, "function");
  assert.match(await contentHash("abc"), /^[0-9a-f]{64}$/);
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
