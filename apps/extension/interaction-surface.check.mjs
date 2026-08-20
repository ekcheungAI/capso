import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const popupHtml = readFileSync(new URL("./popup.html", import.meta.url), "utf8");
const popupJs = readFileSync(new URL("./popup.js", import.meta.url), "utf8");
const optionsHtml = readFileSync(new URL("./options.html", import.meta.url), "utf8");
const optionsJs = readFileSync(new URL("./options.js", import.meta.url), "utf8");

test("popup controls stay full-size, focus-visible and recover a failed capture message", () => {
  assert.match(popupHtml, /#go \{[\s\S]*min-height: 44px/);
  assert.match(popupHtml, /\.modes label \{[^}]*min-height: 44px/);
  assert.match(popupHtml, /\.modes label:has\(input:focus-visible\)/);
  assert.match(popupHtml, /\.project select \{[^}]*min-height: 44px/);
  assert.match(popupHtml, /\.retry \{[^}]*min-height: 44px/);
  assert.match(popupHtml, /id="last" role="status" aria-live="polite"/);
  assert.match(popupHtml, /id="projectNote" role="status" aria-live="polite"/);
  assert.match(popupJs, /catch \{\s*go\.disabled = false;\s*updateCaptureLabel\(\);\s*last\.textContent = "Capso could not start this capture\. Try again\."/);
});

test("options controls stay full-size and Save is timer-safe single-flight", () => {
  assert.match(optionsHtml, /input \{[\s\S]*min-height: 44px/);
  assert.match(optionsHtml, /button \{[\s\S]*min-height: 44px/);
  assert.match(optionsHtml, /id="note" role="status" aria-live="polite"/);
  assert.match(optionsHtml, /<form id="settings">/);
  assert.match(optionsHtml, /<button id="save" type="submit">Save<\/button>/);
  assert.match(optionsJs, /form\.addEventListener\("submit", async \(event\) => \{\s*event\.preventDefault\(\)/);
  assert.match(optionsJs, /if \(save\.disabled\) return;\s*save\.disabled = true;/);
  assert.match(optionsJs, /if \(noteTimer !== null\) clearTimeout\(noteTimer\)/);
  assert.match(optionsJs, /finally \{\s*save\.disabled = false;/);
});
