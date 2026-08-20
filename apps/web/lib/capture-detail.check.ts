import assert from "node:assert/strict";
import test from "node:test";
import {
  captureDetailPresentation,
  imageFilePresentation,
} from "./capture-detail.ts";
import type { Screenshot } from "./store/types.ts";

function capture(fields: Partial<Screenshot> = {}): Screenshot {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Pricing review",
    summary: "",
    whySaved: "",
    ocrText: "",
    intent: "reference",
    type: "web_page",
    threadId: null,
    suggestedThreadId: null,
    confidence: 0,
    status: "done",
    simulated: false,
    assignmentSource: null,
    source: "hotkey_region",
    capturedAt: "2026-08-14T08:00:00.000Z",
    imageDataUrl: null,
    thumbDataUrl: null,
    width: 1440,
    height: 900,
    hue: 210,
    aspect: "wide",
    archived: false,
    pageUrl: null,
    pageTitle: null,
    sourceApp: null,
    tags: [],
    userTags: [],
    ocrSource: null,
    ocrLangs: [],
    contentHash: null,
    originalPath: null,
    thumbPath: null,
    ...fields,
  };
}

test("Mac captures name only the known mode while private availability follows stored evidence", () => {
  const ready = captureDetailPresentation(capture({
    source: "hotkey_region",
    sourceApp: "Safari",
    originalPath: "originals/user/capture.png",
  }), "signed_in");

  assert.deepEqual(ready.origin, {
    label: "Capso for Mac",
    detail: "Area capture · Safari",
  });
  assert.deepEqual(ready.availability, {
    label: "Private account copy",
    detail: "The original is stored privately and available to this signed-in account.",
    state: "ready",
  });
  assert.deepEqual(ready.editing, {
    label: "Flattened library image",
    detail: "Web edits replace this library image; Mac layer and revision state is not available on this page.",
  });
});

test("extension provenance is useful without turning an unsafe source string into a link", () => {
  const waiting = captureDetailPresentation(capture({
    source: "extension",
    pageTitle: "Plans & pricing",
    sourceApp: "example.com",
    pageUrl: "https://example.com/pricing",
  }), "signed_in");
  assert.deepEqual(waiting.origin, {
    label: "Chrome extension",
    detail: "Plans & pricing · example.com",
  });
  assert.equal(waiting.sourceUrl, "https://example.com/pricing");
  assert.equal(waiting.availability.label, "Original not ready");
  assert.equal(waiting.availability.state, "waiting");

  const unsafe = captureDetailPresentation(capture({
    source: "extension",
    pageUrl: "javascript:alert(1)",
  }), "signed_in");
  assert.equal(unsafe.sourceUrl, null);
});

test("local mode describes only this library copy and never invents cloud or Mac safety", () => {
  const local = captureDetailPresentation(capture({ source: "web_upload" }), "local");
  assert.deepEqual(local.availability, {
    label: "This browser only",
    detail: "This library copy is stored in this browser and is not synced to an account.",
    state: "local",
  });
  assert.deepEqual(local.origin, {
    label: "Capso Web",
    detail: "Uploaded file",
  });
});

test("file metadata reports real data bytes but never mistakes a signed URL length for file size", () => {
  assert.deepEqual(
    imageFilePresentation("data:image/png;base64,AQIDBA==", null),
    { format: "PNG", size: "4 B" },
  );
  assert.deepEqual(
    imageFilePresentation("https://storage.example/signed?token=long", "originals/u/capture.jpg"),
    { format: "JPEG", size: null },
  );
  assert.deepEqual(imageFilePresentation("https://storage.example/signed", null), {
    format: "Image",
    size: null,
  });
});
