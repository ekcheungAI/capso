import assert from "node:assert/strict";
import test from "node:test";

import { isOwnCapture, onboardingStage, type Setup } from "./onboarding.ts";

const at = (o: Partial<Parameters<typeof onboardingStage>[0]> = {}) =>
  onboardingStage({
    setup: null,
    firstCaptureDone: false,
    ownCaptures: 0,
    libraryNotEmpty: false,
    ...o,
  });

test("a fresh install is asked what kind of work it is for", () => {
  assert.equal(at(), "pick_role");
});

test("a library that predates the flag is never interrupted", () => {
  assert.equal(at({ setup: null, libraryNotEmpty: true }), "done");
});

test("picking a role lands on the welcome, not on an empty tray", () => {
  // The regression this whole module exists for. Before it, page.tsx tested
  // `threads.length === 0`, which a role template makes false immediately.
  assert.equal(at({ setup: "template", libraryNotEmpty: true }), "first_capture");
});

test("'Start empty' still gets the welcome, not 'done'", () => {
  // The empty role creates no projects, so the library really is empty here —
  // but the user has still done first run and still has nothing captured.
  assert.equal(at({ setup: "empty", libraryNotEmpty: false }), "first_capture");
});

test("samples get the quiet nudge, because the page is not empty", () => {
  assert.equal(at({ setup: "samples", libraryNotEmpty: true }), "nudge");
});

test("seeded fixtures are not captures", () => {
  assert.equal(isOwnCapture({ source: "seed" }), false);
  for (const source of ["hotkey_region", "import", "paste", "extension"]) {
    assert.equal(isOwnCapture({ source }), true, source);
  }
});

test("one real capture finishes onboarding", () => {
  assert.equal(at({ setup: "template", ownCaptures: 1, libraryNotEmpty: true }), "done");
});

test("the latch survives deleting everything", () => {
  // Captured once, then cleared the library. Re-onboarding here would read as
  // the app having forgotten them.
  assert.equal(at({ setup: "template", firstCaptureDone: true, ownCaptures: 0 }), "done");
});

test("samples alone never finish onboarding", () => {
  // 13 seeded rows are on screen and ownCaptures is still 0 — the nudge has to
  // survive that, or loading samples would silently count as capturing.
  assert.equal(at({ setup: "samples", ownCaptures: 0, libraryNotEmpty: true }), "nudge");
});

test("signing in on a new browser does not re-onboard a full library", () => {
  // Remote rows hydrate, localStorage is empty. Without the predates-the-flag
  // rule this shows the front door over a full library.
  assert.equal(at({ setup: null, libraryNotEmpty: true, ownCaptures: 40 }), "done");
});

test("every Setup value maps to a stage", () => {
  for (const setup of ["template", "samples", "empty"] as Setup[]) {
    assert.ok(["first_capture", "nudge", "done"].includes(at({ setup })));
  }
});
