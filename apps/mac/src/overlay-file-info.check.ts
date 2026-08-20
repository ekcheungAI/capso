import assert from "node:assert/strict";
import test from "node:test";
import { overlayCapturedAt, overlayFileSize } from "./overlay-file-info.ts";

test("local-original sizes stay compact and never invent missing metadata", () => {
  assert.equal(overlayFileSize(900), "900 B");
  assert.equal(overlayFileSize(2_048), "2 KB");
  assert.equal(overlayFileSize(1_572_864), "1.5 MB");
  assert.equal(overlayFileSize(0), "Size unavailable");
});

test("local-original dates include the year and reject invalid timestamps", () => {
  assert.match(overlayCapturedAt(new Date(2026, 7, 12, 21, 5).getTime()), /12 Aug 2026/);
  assert.equal(overlayCapturedAt(Number.NaN), "Capture time unavailable");
});
