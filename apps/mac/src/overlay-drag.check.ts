import assert from "node:assert/strict";
import test from "node:test";
import { OverlayDragGesture, suggestedCaptureFilename } from "./overlay-drag.ts";

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
