import assert from "node:assert/strict";
import test from "node:test";
import {
  OverlayDragGesture,
  saveAsFilters,
  saveAsTemplateError,
  suggestedCaptureFilename,
} from "./overlay-drag.ts";

test("a click below the movement threshold never starts native drag", () => {
  const gesture = new OverlayDragGesture(6);
  gesture.begin(4, 100, 100);

  assert.equal(gesture.move(4, 103, 104), false);
  gesture.end(4);
  assert.equal(gesture.move(4, 120, 120), false);
});

test("one pointer gesture starts native drag exactly once after threshold", () => {
  const gesture = new OverlayDragGesture(6);
  gesture.begin(9, 20, 30);

  assert.equal(gesture.move(9, 26, 30), true);
  assert.equal(gesture.move(9, 40, 50), false);
  assert.equal(gesture.move(8, 50, 60), false);
});

test("capture replacement resets an unfinished gesture", () => {
  const gesture = new OverlayDragGesture(6);
  gesture.begin(2, 10, 10);
  gesture.reset();

  assert.equal(gesture.move(2, 30, 30), false);
  gesture.begin(3, 5, 5);
  assert.equal(gesture.move(3, 5, 11), true);
});

test("the friendly drag filename uses one consistent local calendar", () => {
  const localTime = new Date(2026, 0, 2, 3, 4, 5);

  assert.equal(suggestedCaptureFilename(localTime), "Capso 2026-01-02 at 03.04.05.png");
});

test("Save As renders the validated template and preferred extension in one local calendar", () => {
  const localTime = new Date(2026, 0, 2, 3, 4, 5);

  assert.equal(
    suggestedCaptureFilename(localTime, {
      filenameTemplate: "Client review {date} — {time}",
      format: "jpeg",
      directory: "",
    }),
    "Client review 2026-01-02 — 03.04.05.jpg",
  );
  assert.equal(
    suggestedCaptureFilename(localTime, {
      filenameTemplate: "{date} {time}",
      format: "png",
      directory: "",
    }),
    "2026-01-02 03.04.05.png",
  );
});

test("the preferred Save As format is first without removing either explicit choice", () => {
  assert.deepEqual(saveAsFilters("jpeg"), [
    { name: "JPEG image", extensions: ["jpg", "jpeg"] },
    { name: "PNG image", extensions: ["png"] },
  ]);
  assert.deepEqual(saveAsFilters("png"), [
    { name: "PNG image", extensions: ["png"] },
    { name: "JPEG image", extensions: ["jpg", "jpeg"] },
  ]);
});

test("Save As templates reject path syntax, hidden names and unknown tokens", () => {
  assert.equal(saveAsTemplateError("Capso {date} at {time}"), null);
  assert.equal(saveAsTemplateError("Client review"), null);
  for (const invalid of [
    "",
    "../escape {date}",
    "folder/name {time}",
    "folder\\name {time}",
    ".hidden {date}",
    "Unknown {project}",
  ]) {
    assert.notEqual(saveAsTemplateError(invalid), null, invalid);
  }
});
