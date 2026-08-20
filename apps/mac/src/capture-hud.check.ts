import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CAPTURE_DELAYS,
  CAPTURE_MODES,
  DEFAULT_CAPTURE_HUD_SETTINGS,
  WINDOW_BACKGROUNDS,
  WINDOW_PADDINGS,
  delayLabel,
  modeLabel,
  normalizeCaptureHudSettings,
} from "./capture-hud.ts";

const DEFAULT_WINDOW_COLOR = DEFAULT_CAPTURE_HUD_SETTINGS.windowCustomBackground;

test("capture HUD exposes every native capture mode and safe delay", () => {
  assert.deepEqual(CAPTURE_MODES, ["region", "window", "fullscreen"]);
  assert.deepEqual(CAPTURE_DELAYS, [0, 3, 5, 10]);
  assert.equal(modeLabel("region"), "Area");
  assert.equal(modeLabel("fullscreen"), "Full screen");
  assert.equal(delayLabel(0), "No delay");
  assert.equal(delayLabel(10), "10 seconds");
});

test("capture HUD rejects unsafe remembered values", () => {
  assert.deepEqual(DEFAULT_CAPTURE_HUD_SETTINGS, {
    mode: "region",
    delaySeconds: 0,
    freezeScreen: false,
    hideDesktopIcons: false,
    windowShadow: true,
    windowPadding: 0,
    windowBackground: "transparent",
    windowCustomBackground: DEFAULT_WINDOW_COLOR,
  });
  assert.deepEqual(normalizeCaptureHudSettings({ mode: "window", delaySeconds: 3 }), {
    mode: "window",
    delaySeconds: 3,
    freezeScreen: false,
    hideDesktopIcons: false,
    windowShadow: true,
    windowPadding: 0,
    windowBackground: "transparent",
    windowCustomBackground: DEFAULT_WINDOW_COLOR,
  });
  assert.deepEqual(
    normalizeCaptureHudSettings({ mode: "region", delaySeconds: 5, freezeScreen: true }),
    {
      mode: "region",
      delaySeconds: 5,
      freezeScreen: true,
      hideDesktopIcons: false,
      windowShadow: true,
      windowPadding: 0,
      windowBackground: "transparent",
      windowCustomBackground: DEFAULT_WINDOW_COLOR,
    },
  );
  assert.deepEqual(
    normalizeCaptureHudSettings({ mode: "window", delaySeconds: 3, freezeScreen: true }),
    {
      mode: "window",
      delaySeconds: 3,
      freezeScreen: false,
      hideDesktopIcons: false,
      windowShadow: true,
      windowPadding: 0,
      windowBackground: "transparent",
      windowCustomBackground: DEFAULT_WINDOW_COLOR,
    },
  );
  assert.deepEqual(
    normalizeCaptureHudSettings({ mode: "fullscreen", delaySeconds: 0, freezeScreen: true }),
    {
      mode: "fullscreen",
      delaySeconds: 0,
      freezeScreen: false,
      hideDesktopIcons: false,
      windowShadow: true,
      windowPadding: 0,
      windowBackground: "transparent",
      windowCustomBackground: DEFAULT_WINDOW_COLOR,
    },
  );
  assert.deepEqual(
    normalizeCaptureHudSettings({ mode: "scrolling", delaySeconds: 120 }),
    DEFAULT_CAPTURE_HUD_SETTINGS,
  );
  assert.deepEqual(normalizeCaptureHudSettings(null), DEFAULT_CAPTURE_HUD_SETTINGS);
});

test("window finishing accepts only bounded padding, named backgrounds, and one exact custom colour", () => {
  const customColour = `#${"a1"}${"b2"}${"c3"}`;
  assert.deepEqual(WINDOW_PADDINGS, [0, 24, 48, 72]);
  assert.deepEqual(WINDOW_BACKGROUNDS, ["transparent", "canvas", "ink", "blue", "custom"]);
  assert.deepEqual(
    normalizeCaptureHudSettings({
      mode: "window",
      delaySeconds: 0,
      freezeScreen: false,
      hideDesktopIcons: true,
      windowShadow: false,
      windowPadding: 48,
      windowBackground: "custom",
      windowCustomBackground: customColour,
    }),
    {
      mode: "window",
      delaySeconds: 0,
      freezeScreen: false,
      hideDesktopIcons: true,
      windowShadow: false,
      windowPadding: 48,
      windowBackground: "custom",
      windowCustomBackground: customColour.toUpperCase(),
    },
  );
  const unsafe = normalizeCaptureHudSettings({
    mode: "window",
    delaySeconds: 0,
    windowShadow: "yes",
    windowPadding: 4096,
    windowBackground: "url(data:secret)",
    windowCustomBackground: "red",
  });
  assert.deepEqual(unsafe, {
    ...DEFAULT_CAPTURE_HUD_SETTINGS,
    mode: "window",
  });
});

test("freeze screen owns a private native surface and bounded lifecycle", async () => {
  const [component, entrypoint, native, capture, config, capability] = await Promise.all([
    readFile(new URL("./FreezeScreen.tsx", import.meta.url), "utf8"),
    readFile(new URL("./main.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/freeze.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/capture.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/capabilities/freeze-screen.json", import.meta.url), "utf8"),
  ]);

  assert.match(entrypoint, /surface === "freeze"/);
  assert.match(component, /freeze_frame_ready/);
  assert.match(component, /cancel_freeze_capture/);
  assert.match(native, /generation/);
  assert.match(native, /wait_until_ready/);
  assert.match(native, /cleanup/);
  assert.match(capture, /capture_frozen_area/);
  assert.match(config, /"label": "freeze-screen"/);
  assert.match(config, /\$APPDATA\/freeze\/\*\*/);
  assert.match(capability, /"windows": \["freeze-screen"\]/);
});

test("capture HUD is a native keyboard-accessible surface", async () => {
  const [component, entrypoint, native, capture, config] = await Promise.all([
    readFile(new URL("./CaptureHud.tsx", import.meta.url), "utf8"),
    readFile(new URL("./main.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/capture.rs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  ]);

  assert.match(entrypoint, /surface === "capture-hud"/);
  assert.match(component, /role="radiogroup" aria-label="Capture mode"/);
  assert.match(component, /role="radiogroup" aria-label="Capture delay"/);
  assert.match(component, /event\.key === "Escape"/);
  assert.match(component, /event\.key === "Enter"/);
  assert.match(component, /invoke\("start_capture_from_hud"/);
  assert.match(component, /invoke\("start_previous_area_capture"/);
  assert.match(component, /aria-label="Window padding"/);
  assert.match(component, /aria-label="Window background"/);
  assert.match(component, /Include window shadow/);
  assert.match(capture, /capture_hud::load_settings/);
  assert.match(capture, /run_window_capture_with_style/);
  assert.match(component, /Previous area/);
  assert.match(component, /previousArea\.available/);
  assert.match(component, /invoke\("hide_capture_hud"/);
  assert.match(native, /show_capture_hud/);
  assert.match(config, /"label": "capture-hud"/);
  assert.match(config, /"alwaysOnTop": true/);
});
