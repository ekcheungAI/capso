import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Element capture is discoverable, remembered, routed, and keyboard-addressable", async () => {
  const [popup, popupLogic, background, manifest] = await Promise.all([
    readFile(new URL("./popup.html", import.meta.url), "utf8"),
    readFile(new URL("./popup.js", import.meta.url), "utf8"),
    readFile(new URL("./background.js", import.meta.url), "utf8"),
    readFile(new URL("./manifest.json", import.meta.url), "utf8"),
  ]);

  assert.match(popup, /value="element"[^>]*\/>Element/);
  assert.match(popup, /grid-template-columns:\s*repeat\(4,/);
  assert.match(popupLogic, /\["visible", "element", "area", "full_page"\]/);
  assert.match(popupLogic, /mode === "element"[\s\S]*?Select an element/);
  assert.match(background, /captureElement/);
  assert.match(background, /mode === "element"[\s\S]*?captureElement\(\)/);
  assert.match(background, /command === "capture-element"/);
  assert.match(manifest, /"capture-element"/);
  assert.match(background, /captureElement/);

  const capture = await readFile(new URL("./capture.js", import.meta.url), "utf8");
  assert.match(capture, /addEventListener\("pointercancel"/);
});
