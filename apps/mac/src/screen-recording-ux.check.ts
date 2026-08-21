import assert from "node:assert/strict";
import test from "node:test";

type PresentationModule = typeof import("./screen-recording-ux.ts");

async function loadPresentation(): Promise<PresentationModule | null> {
  try {
    return await import("./screen-recording-ux.ts");
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("Cannot find module") ||
        error.message.includes("ERR_MODULE_NOT_FOUND"))
    ) {
      return null;
    }
    throw error;
  }
}

test("a granted build presents every screenshot mode as ready", async () => {
  const module = await loadPresentation();
  assert.ok(module, "screen-recording-ux.ts should provide the permission presentation");

  const view = module.screenRecordingPresentation({
    screenRecording: "granted",
    screenRecordingRequestAttempted: true,
    screenRecordingIdentity: "stable",
  });

  assert.equal(view.stateLabel, "All modes ready");
  assert.match(view.captureDetail, /Area, Window, and Full Screen/i);
  assert.equal(view.noticeTone, "success");
  assert.equal(view.primaryAction, null);
  assert.equal(view.showRestart, false);
});

test("an ad-hoc build explains why macOS can show an older Capso as enabled", async () => {
  const module = await loadPresentation();
  assert.ok(module, "screen-recording-ux.ts should provide the permission presentation");

  const view = module.screenRecordingPresentation({
    screenRecording: "required",
    screenRecordingRequestAttempted: false,
    screenRecordingIdentity: "buildSpecific",
  });

  assert.equal(view.stateLabel, "Setup required");
  assert.match(view.notice, /temporary macOS identity/i);
  assert.match(view.notice, /older Capso build/i);
  assert.doesNotMatch(view.notice, /access is (?:still )?off/i);
  assert.equal(view.primaryAction, "request");
  assert.equal(view.primaryLabel, "Grant access");
});

test("an unsuccessful permission attempt offers Settings and a real restart", async () => {
  const module = await loadPresentation();
  assert.ok(module, "screen-recording-ux.ts should provide the permission presentation");

  const view = module.screenRecordingPresentation({
    screenRecording: "required",
    screenRecordingRequestAttempted: true,
    screenRecordingIdentity: "stable",
  });

  assert.equal(view.primaryAction, "settings");
  assert.equal(view.primaryLabel, "Open settings");
  assert.equal(view.showRestart, true);
  assert.match(view.notice, /already shows Capso on/i);
  assert.match(view.notice, /restart Capso/i);
  assert.doesNotMatch(view.notice, /access is (?:still )?off/i);
});

test("an unknown signing identity fails closed with actionable build guidance", async () => {
  const module = await loadPresentation();
  assert.ok(module, "screen-recording-ux.ts should provide the permission presentation");

  const view = module.screenRecordingPresentation({
    screenRecording: "required",
    screenRecordingRequestAttempted: false,
    screenRecordingIdentity: "unknown",
  });

  assert.equal(view.stateLabel, "Setup required");
  assert.match(view.notice, /could not verify.*stable macOS identity/i);
  assert.equal(view.noticeTone, "attention");
});
