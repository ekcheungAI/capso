import assert from "node:assert/strict";
import test from "node:test";
import { OverlayActionCoordinator } from "./overlay-actions.ts";

test("an old dismiss response cannot erase a newer capture", () => {
  const coordinator = new OverlayActionCoordinator();
  const oldGeneration = coordinator.activateCapture("/captures/old.png");
  const oldDismiss = coordinator.begin("/captures/old.png", "dismiss");
  assert.ok(oldDismiss);
  assert.equal(oldDismiss.captureGeneration, oldGeneration);

  const newGeneration = coordinator.activateCapture("/captures/new.png");
  assert.ok(newGeneration > oldGeneration);
  assert.equal(coordinator.dismiss(oldDismiss), false);
  assert.equal(coordinator.generation(), newGeneration);
});

test("an old finally cannot re-enable controls during a newer action", () => {
  const coordinator = new OverlayActionCoordinator();
  coordinator.activateCapture("/captures/old.png");
  const oldCopy = coordinator.begin("/captures/old.png", "copy");
  assert.ok(oldCopy);

  coordinator.activateCapture("/captures/new.png");
  const newSave = coordinator.begin("/captures/new.png", "save");
  assert.ok(newSave);

  assert.equal(coordinator.isCurrent(oldCopy), false);
  assert.equal(coordinator.finish(oldCopy), false);
  assert.equal(coordinator.isCurrent(newSave), true);
  assert.equal(coordinator.finish(newSave), true);
});

test("a repeated path still receives a new capture generation", () => {
  const coordinator = new OverlayActionCoordinator();
  coordinator.activateCapture("/captures/current.png");
  const oldAction = coordinator.begin("/captures/current.png", "copy");
  assert.ok(oldAction);

  coordinator.activateCapture("/captures/current.png");
  assert.equal(coordinator.isCurrent(oldAction), false);
});

test("annotation stays serialized until save or cancel refreshes the presentation", () => {
  const coordinator = new OverlayActionCoordinator();
  coordinator.activateCapture("/captures/current.png");
  const annotate = coordinator.begin("/captures/current.png", "annotate");
  assert.ok(annotate);
  assert.equal(coordinator.begin("/captures/current.png", "copy"), null);

  coordinator.activateCapture("/captures/current.png");
  assert.equal(coordinator.isCurrent(annotate), false);
  assert.ok(coordinator.begin("/captures/current.png", "copy"));
});

test("a native timeout invalidates the exact renderer capture and every old action", () => {
  const coordinator = new OverlayActionCoordinator();
  const presentation = coordinator.activateCapture("/captures/current.png");
  const action = coordinator.begin("/captures/current.png", "copy");
  assert.ok(action);

  assert.equal(coordinator.deactivateCapture("/captures/other.png"), false);
  assert.equal(coordinator.generation(), presentation);
  assert.equal(coordinator.deactivateCapture("/captures/current.png"), true);
  assert.equal(coordinator.generation(), presentation + 1);
  assert.equal(coordinator.isCurrent(action), false);
  assert.equal(coordinator.begin("/captures/current.png", "copy"), null);
});
