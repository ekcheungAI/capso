import assert from "node:assert/strict";
import test from "node:test";

import {
  firstRunAction,
  firstRunComplete,
  firstRunSteps,
  type FirstRunInput,
} from "./onboarding.ts";

const at = (o: Partial<FirstRunInput> = {}): FirstRunInput => ({
  screenRecording: "required",
  screenRecordingSkipped: false,
  launchAtLogin: "unknown",
  hotkeyConfirmed: false,
  cloudConfigured: true,
  libraryChoice: "undecided",
  hasCaptured: false,
  ...o,
});

const stateOf = (input: FirstRunInput, id: string) =>
  firstRunSteps(input).find((s) => s.id === id)!.state;

test("a fresh install starts at the permission step", () => {
  assert.equal(firstRunAction(at()), "permission");
  assert.equal(stateOf(at(), "permission"), "current");
});

test("exactly one step is current, always", () => {
  for (const input of [
    at(),
    at({ screenRecording: "granted" }),
    at({ screenRecording: "granted", hotkeyConfirmed: true }),
    at({ screenRecording: "granted", hotkeyConfirmed: true, launchAtLogin: "enabled" }),
  ]) {
    assert.equal(firstRunSteps(input).filter((s) => s.state === "current").length, 1);
  }
});

test("steps advance in order", () => {
  assert.equal(firstRunAction(at({ screenRecording: "granted" })), "hotkey");
  assert.equal(
    firstRunAction(at({ screenRecording: "granted", hotkeyConfirmed: true })),
    "login",
  );
});

test("Area-only setup can continue without Screen Recording permission", () => {
  const areaOnly = at({ screenRecordingSkipped: true });
  const permission = firstRunSteps(areaOnly).find((step) => step.id === "permission")!;

  assert.equal(permission.state, "done");
  assert.equal(permission.optional, true);
  assert.match(permission.detail, /Area only/i);
  assert.match(permission.detail, /later/i);
  assert.equal(firstRunAction(areaOnly), "hotkey");
});

test("a later Screen Recording grant replaces stale Area-only guidance", () => {
  const permission = firstRunSteps(
    at({ screenRecording: "granted", screenRecordingSkipped: true }),
  ).find((step) => step.id === "permission")!;

  assert.equal(permission.state, "done");
  assert.doesNotMatch(permission.detail, /Area only/i);
  assert.doesNotMatch(permission.detail, /later/i);
});

test("library connection is an explicit decision before the first capture", () => {
  const readyForLibrary = at({
    screenRecording: "granted",
    hotkeyConfirmed: true,
    launchAtLogin: "disabled",
  });

  assert.equal(firstRunAction(readyForLibrary), "library");
  assert.equal(stateOf(readyForLibrary, "library"), "current");
  assert.equal(stateOf(readyForLibrary, "capture"), "todo");
  assert.match(
    firstRunSteps(readyForLibrary).find((step) => step.id === "library")!.detail,
    /Mac, the web, and your Chrome extension/i,
  );
});

test("connected and deliberate local-only choices both settle the library step", () => {
  for (const libraryChoice of ["connected", "local_only"] as const) {
    const input = at({
      screenRecording: "granted",
      hotkeyConfirmed: true,
      launchAtLogin: "disabled",
      libraryChoice,
    });
    assert.equal(stateOf(input, "library"), "done");
    assert.equal(firstRunAction(input), "capture");
  }

  const local = firstRunSteps(at({ libraryChoice: "local_only" }))
    .find((step) => step.id === "library")!;
  assert.match(local.detail, /Local only/i);
  assert.match(local.detail, /Account Settings/i);
});

test("an unconfigured build offers an honest local-only path", () => {
  const library = firstRunSteps(at({ cloudConfigured: false }))
    .find((step) => step.id === "library")!;

  assert.match(library.detail, /unavailable in this build/i);
  assert.match(library.detail, /private on this Mac/i);
});

test("declining the login item settles it rather than leaving it unfinished", () => {
  // The trap: treating "disabled" as todo leaves a permanent unticked row for a
  // user who deliberately said no.
  assert.equal(stateOf(at({ launchAtLogin: "disabled" }), "login"), "done");
  assert.equal(stateOf(at({ launchAtLogin: "enabled" }), "login"), "done");
  assert.equal(stateOf(at({ launchAtLogin: "unknown" }), "login"), "todo");
});

test("the optional step never blocks completion", () => {
  const skippedLogin = at({
    screenRecording: "granted",
    hotkeyConfirmed: true,
    libraryChoice: "local_only",
    hasCaptured: true,
    launchAtLogin: "unknown",
  });
  assert.equal(firstRunComplete(skippedLogin), true);
});

test("either a grant or an explicit Area-only choice settles capture access", () => {
  const all = at({
    screenRecording: "granted",
    hotkeyConfirmed: true,
    libraryChoice: "connected",
    hasCaptured: true,
    launchAtLogin: "enabled",
  });
  assert.equal(firstRunComplete(all), true);
  assert.equal(
    firstRunComplete({ ...all, screenRecording: "required", screenRecordingSkipped: true }),
    true,
  );
  assert.equal(
    firstRunComplete({ ...all, screenRecording: "required", screenRecordingSkipped: false }),
    false,
  );
  assert.equal(firstRunComplete({ ...all, hotkeyConfirmed: false }), false);
  assert.equal(firstRunComplete({ ...all, libraryChoice: "undecided" }), false);
  assert.equal(firstRunComplete({ ...all, hasCaptured: false }), false);
});

test("a saved Area-only choice stays complete without Screen Recording", () => {
  const back = at({
    screenRecording: "required",
    screenRecordingSkipped: true,
    hotkeyConfirmed: true,
    libraryChoice: "local_only",
    hasCaptured: true,
  });
  assert.equal(firstRunAction(back), null);
  assert.equal(firstRunComplete(back), true);
});

test("a completed run has no current step", () => {
  const done = at({
    screenRecording: "granted",
    hotkeyConfirmed: true,
    libraryChoice: "connected",
    hasCaptured: true,
    launchAtLogin: "enabled",
  });
  assert.equal(firstRunAction(done), null);
});

test("every step carries one line of detail", () => {
  for (const step of firstRunSteps(at())) {
    assert.ok(step.detail.length > 0, step.id);
    assert.ok(!step.detail.includes("\n"), step.id);
  }
});
