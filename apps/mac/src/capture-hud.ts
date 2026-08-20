import { intent } from "@capso/shared/tokens";

export const CAPTURE_MODES = ["region", "window", "fullscreen"] as const;
export const CAPTURE_DELAYS = [0, 3, 5, 10] as const;
export const WINDOW_PADDINGS = [0, 24, 48, 72] as const;
export const WINDOW_BACKGROUNDS = ["transparent", "canvas", "ink", "blue", "custom"] as const;

export type CaptureMode = (typeof CAPTURE_MODES)[number];
export type CaptureDelay = (typeof CAPTURE_DELAYS)[number];
export type WindowPadding = (typeof WINDOW_PADDINGS)[number];
export type WindowBackground = (typeof WINDOW_BACKGROUNDS)[number];

export type CaptureHudSettings = {
  mode: CaptureMode;
  delaySeconds: CaptureDelay;
  freezeScreen: boolean;
  hideDesktopIcons: boolean;
  windowShadow: boolean;
  windowPadding: WindowPadding;
  windowBackground: WindowBackground;
  windowCustomBackground: string;
};

export type PreviousAreaStatus = {
  available: boolean;
  label: string | null;
  unavailableReason: string | null;
};

export type CaptureHudStatus = {
  settings: CaptureHudSettings;
  storageWarning: string | null;
  desktopClutterWarning: string | null;
  previousArea: PreviousAreaStatus;
};

export const DEFAULT_CAPTURE_HUD_SETTINGS: CaptureHudSettings = {
  mode: "region",
  delaySeconds: 0,
  freezeScreen: false,
  hideDesktopIcons: false,
  windowShadow: true,
  windowPadding: 0,
  windowBackground: "transparent",
  windowCustomBackground: intent.reference.toUpperCase(),
};

export const PREVIEW_PREVIOUS_AREA: PreviousAreaStatus = {
  available: true,
  label: "960 × 540",
  unavailableReason: null,
};

export const EMPTY_PREVIOUS_AREA: PreviousAreaStatus = {
  available: false,
  label: null,
  unavailableReason: "Choose Area once to save a reusable selection.",
};

export function isCaptureMode(value: unknown): value is CaptureMode {
  return typeof value === "string" && CAPTURE_MODES.includes(value as CaptureMode);
}

export function isCaptureDelay(value: unknown): value is CaptureDelay {
  return typeof value === "number" && CAPTURE_DELAYS.includes(value as CaptureDelay);
}

function isWindowPadding(value: unknown): value is WindowPadding {
  return typeof value === "number" && WINDOW_PADDINGS.includes(value as WindowPadding);
}

function isWindowBackground(value: unknown): value is WindowBackground {
  return typeof value === "string" && WINDOW_BACKGROUNDS.includes(value as WindowBackground);
}

function exactHex(value: unknown) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
    ? value.toUpperCase()
    : DEFAULT_CAPTURE_HUD_SETTINGS.windowCustomBackground;
}

export function normalizeCaptureHudSettings(value: unknown): CaptureHudSettings {
  if (!value || typeof value !== "object") return DEFAULT_CAPTURE_HUD_SETTINGS;
  const candidate = value as {
    mode?: unknown;
    delaySeconds?: unknown;
    freezeScreen?: unknown;
    hideDesktopIcons?: unknown;
    windowShadow?: unknown;
    windowPadding?: unknown;
    windowBackground?: unknown;
    windowCustomBackground?: unknown;
  };
  if (!isCaptureMode(candidate.mode) || !isCaptureDelay(candidate.delaySeconds)) {
    return DEFAULT_CAPTURE_HUD_SETTINGS;
  }
  return {
    mode: candidate.mode,
    delaySeconds: candidate.delaySeconds,
    freezeScreen: candidate.mode === "region" && candidate.freezeScreen === true,
    hideDesktopIcons: candidate.hideDesktopIcons === true,
    windowShadow: typeof candidate.windowShadow === "boolean" ? candidate.windowShadow : true,
    windowPadding: isWindowPadding(candidate.windowPadding) ? candidate.windowPadding : 0,
    windowBackground: isWindowBackground(candidate.windowBackground)
      ? candidate.windowBackground
      : "transparent",
    windowCustomBackground: exactHex(candidate.windowCustomBackground),
  };
}

export function modeLabel(mode: CaptureMode): string {
  switch (mode) {
    case "region":
      return "Area";
    case "window":
      return "Window";
    case "fullscreen":
      return "Full screen";
  }
}

export function delayLabel(delay: CaptureDelay): string {
  if (delay === 0) return "No delay";
  return `${delay} seconds`;
}

export function adjacentOption<T>(options: readonly T[], current: T, offset: -1 | 1): T {
  const index = Math.max(0, options.indexOf(current));
  return options[(index + offset + options.length) % options.length];
}
