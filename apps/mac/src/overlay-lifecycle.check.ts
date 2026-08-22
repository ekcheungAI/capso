import assert from "node:assert/strict";
import test from "node:test";
import {
  reduceOverlayLifecycle,
  type OverlayLifecycleEvent,
  type OverlayLifecycleState,
} from "./overlay-lifecycle.ts";

const capture = (
  path: string,
  presentationId: number,
  surfaceGeneration: number,
  temporarilyHidden = false,
) => ({ path, presentationId, surfaceGeneration, temporarilyHidden });

function apply(
  state: OverlayLifecycleState,
  event: OverlayLifecycleEvent,
) {
  const result = reduceOverlayLifecycle(state, event);
  assert.equal(result.decision, "apply");
  return result.state;
}

test("ordered capture, hide, restore and dismiss ends warm and empty", () => {
  let state: OverlayLifecycleState = { surfaceGeneration: 0, capture: null };
  state = apply(state, { kind: "capture", capture: capture("/a.png", 1, 1) });
  state = apply(state, {
    kind: "hidden",
    path: "/a.png",
    presentationId: 1,
    surfaceGeneration: 2,
  });
  assert.equal(state.capture?.temporarilyHidden, true);
  state = apply(state, {
    kind: "restored",
    path: "/a.png",
    presentationId: 1,
    surfaceGeneration: 3,
  });
  assert.equal(state.capture?.temporarilyHidden, false);
  state = apply(state, {
    kind: "dismissed",
    path: "/a.png",
    presentationId: 1,
    surfaceGeneration: 4,
  });
  assert.deepEqual(state, { surfaceGeneration: 4, capture: null });
});

test("delayed events and equal-generation duplicates cannot revive pixels", () => {
  const dismissed = apply(
    { surfaceGeneration: 3, capture: capture("/a.png", 1, 3) },
    {
      kind: "dismissed",
      path: "/a.png",
      presentationId: 1,
      surfaceGeneration: 4,
    },
  );

  for (const event of [
    { kind: "hidden", path: "/a.png", presentationId: 1, surfaceGeneration: 2 },
    { kind: "restored", path: "/a.png", presentationId: 1, surfaceGeneration: 3 },
    { kind: "capture", capture: capture("/a.png", 1, 4) },
  ] satisfies OverlayLifecycleEvent[]) {
    const result = reduceOverlayLifecycle(dismissed, event);
    assert.equal(result.decision, "ignore");
    assert.equal(result.state, dismissed);
  }
});

test("rapid replacement rejects old path and repeated-path presentations", () => {
  let state: OverlayLifecycleState = { surfaceGeneration: 0, capture: null };
  state = apply(state, { kind: "capture", capture: capture("/a.png", 1, 1) });
  state = apply(state, { kind: "capture", capture: capture("/b.png", 2, 2) });
  state = apply(state, { kind: "capture", capture: capture("/b.png", 3, 3) });

  assert.equal(
    reduceOverlayLifecycle(state, {
      kind: "restored",
      path: "/b.png",
      presentationId: 2,
      surfaceGeneration: 2,
    }).decision,
    "ignore",
  );
  assert.equal(state.capture?.presentationId, 3);
});

test("an identity event before its capture requests one authoritative resync", () => {
  const initial: OverlayLifecycleState = { surfaceGeneration: 1, capture: null };
  const earlyHidden = reduceOverlayLifecycle(initial, {
    kind: "hidden",
    path: "/b.png",
    presentationId: 2,
    surfaceGeneration: 3,
  });
  assert.deepEqual(earlyHidden, {
    decision: "resync",
    state: { surfaceGeneration: 3, capture: null },
  });
  assert.equal(
    reduceOverlayLifecycle(earlyHidden.state, {
      kind: "capture",
      capture: capture("/b.png", 2, 2),
    }).decision,
    "ignore",
  );

  const snapshot = reduceOverlayLifecycle(earlyHidden.state, {
    kind: "bootstrap",
    surfaceGeneration: 4,
    capture: capture("/b.png", 2, 4, true),
  });
  assert.equal(snapshot.decision, "apply");
  assert.equal(snapshot.state.capture?.temporarilyHidden, true);
});

test("a live event wins over a late bootstrap snapshot", () => {
  const live = apply(
    { surfaceGeneration: 4, capture: null },
    { kind: "capture", capture: capture("/live.png", 5, 5) },
  );
  const late = reduceOverlayLifecycle(live, {
    kind: "bootstrap",
    surfaceGeneration: 4,
    capture: capture("/stale.png", 4, 4),
  });
  assert.equal(late.decision, "ignore");
  assert.equal(late.state, live);
});

test("a native timeout advances generation after local cleanup", () => {
  const result = reduceOverlayLifecycle(
    { surfaceGeneration: 8, capture: null },
    {
      kind: "dismissed",
      path: "/already-cleared.png",
      presentationId: 7,
      surfaceGeneration: 9,
    },
  );
  assert.deepEqual(result, {
    decision: "apply",
    state: { surfaceGeneration: 9, capture: null },
  });
});
