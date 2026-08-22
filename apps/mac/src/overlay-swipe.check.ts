import assert from "node:assert/strict";
import test from "node:test";
import { OverlaySwipeGesture } from "./overlay-swipe.ts";

test("a physical trackpad swipe to the right is normalized for either scroll direction", () => {
  const standard = new OverlaySwipeGesture();
  const natural = new OverlaySwipeGesture();

  assert.deepEqual(
    standard.move({ deltaX: 32, deltaY: 2, deltaMode: 0, directionInvertedFromDevice: false }, 304),
    { kind: "tracking", offsetX: 32 },
  );
  assert.deepEqual(
    natural.move({ deltaX: -32, deltaY: 2, deltaMode: 0, directionInvertedFromDevice: true }, 304),
    { kind: "tracking", offsetX: 32 },
  );
});

test("vertical wheels, line-mode wheels, and leftward starts never become a dismiss swipe", () => {
  for (const sample of [
    { deltaX: 4, deltaY: 18, deltaMode: 0, directionInvertedFromDevice: false },
    { deltaX: 30, deltaY: 25, deltaMode: 0, directionInvertedFromDevice: false },
    { deltaX: 30, deltaY: 0, deltaMode: 1, directionInvertedFromDevice: false },
    { deltaX: -30, deltaY: 0, deltaMode: 0, directionInvertedFromDevice: false },
  ]) {
    const gesture = new OverlaySwipeGesture();
    assert.deepEqual(gesture.move(sample, 304), { kind: "ignored" });
    assert.equal(gesture.offset(), 0);
  }
});

test("a right swipe tracks one-to-one and commits once at the responsive threshold", () => {
  const gesture = new OverlaySwipeGesture();

  assert.deepEqual(
    gesture.move({ deltaX: 40, deltaY: 1, deltaMode: 0, directionInvertedFromDevice: false }, 304),
    { kind: "tracking", offsetX: 40 },
  );
  assert.deepEqual(
    gesture.move({ deltaX: 36, deltaY: 0, deltaMode: 0, directionInvertedFromDevice: false }, 304),
    { kind: "dismiss", offsetX: 76 },
  );
  assert.deepEqual(
    gesture.move({ deltaX: 20, deltaY: 0, deltaMode: 0, directionInvertedFromDevice: false }, 304),
    { kind: "ignored" },
  );
});

test("a sub-threshold swipe can snap back and start cleanly again", () => {
  const gesture = new OverlaySwipeGesture();
  gesture.move({ deltaX: 28, deltaY: 0, deltaMode: 0, directionInvertedFromDevice: false }, 304);

  gesture.reset();

  assert.equal(gesture.offset(), 0);
  assert.deepEqual(
    gesture.move({ deltaX: 18, deltaY: 0, deltaMode: 0, directionInvertedFromDevice: false }, 304),
    { kind: "tracking", offsetX: 18 },
  );
});
