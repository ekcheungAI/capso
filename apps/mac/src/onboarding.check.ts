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
  launchAtLogin: "unknown",
  hotkeyConfirmed: false,
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
    hasCaptured: true,
    launchAtLogin: "unknown",
  });
  assert.equal(firstRunComplete(skippedLogin), true);
});

test("first run is not complete without permission, hotkey or a capture", () => {
  const all = at({
    screenRecording: "granted",
    hotkeyConfirmed: true,
    hasCaptured: true,
    launchAtLogin: "enabled",
  });
  assert.equal(firstRunComplete(all), true);
  assert.equal(firstRunComplete({ ...all, screenRecording: "required" }), false);
  assert.equal(firstRunComplete({ ...all, hotkeyConfirmed: false }), false);
  assert.equal(firstRunComplete({ ...all, hasCaptured: false }), false);
});

test("revoking permission mid-run puts the user back on that step", () => {
  // macOS can drop the grant between launches; the flow has to survive going
  // backwards, not just forwards.
  const back = at({ screenRecording: "required", hotkeyConfirmed: true, hasCaptured: true });
  assert.equal(firstRunAction(back), "permission");
  assert.equal(firstRunComplete(back), false);
});

test("a completed run has no current step", () => {
  const done = at({
    screenRecording: "granted",
    hotkeyConfirmed: true,
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
