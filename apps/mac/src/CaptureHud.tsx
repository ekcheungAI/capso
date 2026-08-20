import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  CAPTURE_DELAYS,
  CAPTURE_MODES,
  DEFAULT_CAPTURE_HUD_SETTINGS,
  EMPTY_PREVIOUS_AREA,
  PREVIEW_PREVIOUS_AREA,
  WINDOW_BACKGROUNDS,
  WINDOW_PADDINGS,
  adjacentOption,
  delayLabel,
  modeLabel,
  normalizeCaptureHudSettings,
  type CaptureDelay,
  type CaptureHudSettings,
  type CaptureHudStatus,
  type CaptureMode,
  type PreviousAreaStatus,
  type WindowBackground,
  type WindowPadding,
} from "./capture-hud";

const MODE_DETAIL: Record<CaptureMode, string> = {
  region: "Select exactly what matters",
  window: "Pick one app window",
  fullscreen: "Capture this display",
};

const WINDOW_BACKGROUND_LABEL: Record<WindowBackground, string> = {
  transparent: "Transparent",
  canvas: "Canvas",
  ink: "Ink",
  blue: "Capso blue",
  custom: "Custom",
};

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

function focusOption(kind: "mode" | "delay", value: string | number) {
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(`[data-${kind}="${value}"]`)?.focus();
  });
}

export default function CaptureHud() {
  const nativeRuntime = useMemo(isTauriRuntime, []);
  const previewPreviousArea = useMemo(
    () => new URLSearchParams(window.location.search).get("previous") !== "missing",
    [],
  );
  const [settings, setSettings] = useState<CaptureHudSettings>(DEFAULT_CAPTURE_HUD_SETTINGS);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const [desktopClutterWarning, setDesktopClutterWarning] = useState<string | null>(null);
  const [previousArea, setPreviousArea] = useState<PreviousAreaStatus>(() =>
    nativeRuntime || !previewPreviousArea ? EMPTY_PREVIOUS_AREA : PREVIEW_PREVIOUS_AREA,
  );
  const [loading, setLoading] = useState(nativeRuntime);
  const [busy, setBusy] = useState(false);
  const captureLaunchInFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!nativeRuntime) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    async function loadStatus() {
      try {
        const status = await invoke<CaptureHudStatus>("get_capture_hud_settings");
        if (disposed) return;
        setSettings(normalizeCaptureHudSettings(status.settings));
        setStorageWarning(status.storageWarning);
        setDesktopClutterWarning(status.desktopClutterWarning);
        setPreviousArea(status.previousArea);
      } catch (reason) {
        if (!disposed) setError(`Could not load capture choices: ${String(reason)}`);
      } finally {
        if (!disposed) setLoading(false);
      }
    }
    void (async () => {
      const stopListening = await listen("capture-hud-opened", () => {
        if (disposed) return;
        captureLaunchInFlight.current = false;
        setBusy(false);
        setError(null);
        setLoading(true);
        void loadStatus();
      });
      if (disposed) {
        stopListening();
        return;
      }
      unlisten = stopListening;
      await loadStatus();
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [nativeRuntime]);

  async function dismiss() {
    if (!nativeRuntime) return;
    try {
      await invoke("hide_capture_hud");
    } catch (reason) {
      setError(`Could not close capture controls: ${String(reason)}`);
    }
  }

  async function openRecordingStudio() {
    setError(null);
    if (!nativeRuntime) return;
    try {
      await invoke("open_recording_studio");
      await invoke("hide_capture_hud");
    } catch (reason) {
      setError(`Could not open recording controls: ${String(reason)}`);
    }
  }

  function beginCaptureLaunch() {
    if (captureLaunchInFlight.current || loading) return false;
    captureLaunchInFlight.current = true;
    setBusy(true);
    setError(null);
    return true;
  }

  function releaseCaptureLaunch() {
    captureLaunchInFlight.current = false;
    setBusy(false);
  }

  async function startCapture() {
    if (!beginCaptureLaunch()) return;
    if (!nativeRuntime) {
      window.setTimeout(releaseCaptureLaunch, 360);
      return;
    }
    try {
      await invoke("start_capture_from_hud", { settings });
    } catch (reason) {
      setError(`Could not start capture: ${String(reason)}`);
      releaseCaptureLaunch();
    }
  }

  async function startPreviousArea() {
    if (!previousArea.available || !beginCaptureLaunch()) return;
    if (!nativeRuntime) {
      window.setTimeout(releaseCaptureLaunch, 360);
      return;
    }
    try {
      await invoke("start_previous_area_capture");
    } catch (reason) {
      setError(`Could not capture Previous Area: ${String(reason)}`);
      releaseCaptureLaunch();
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void dismiss();
      } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void startCapture();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, loading, nativeRuntime, settings]);

  function moveMode(event: ReactKeyboardEvent, offset: -1 | 1) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const mode = adjacentOption(CAPTURE_MODES, settings.mode, offset);
    setSettings((current) => ({
      ...current,
      mode,
      freezeScreen: mode === "region" && current.freezeScreen,
    }));
    focusOption("mode", mode);
  }

  function moveDelay(event: ReactKeyboardEvent, offset: -1 | 1) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delaySeconds = adjacentOption(CAPTURE_DELAYS, settings.delaySeconds, offset);
    setSettings((current) => ({ ...current, delaySeconds }));
    focusOption("delay", delaySeconds);
  }

  return (
    <main
      className="capture-hud"
      data-mode={settings.mode}
      aria-labelledby="capture-hud-title"
      aria-busy={busy}
    >
      <header className="capture-hud__header" data-tauri-drag-region>
        <div data-tauri-drag-region>
          <span data-tauri-drag-region>CAPSO CAPTURE</span>
          <h1 id="capture-hud-title" data-tauri-drag-region>
            Take a screenshot
          </h1>
        </div>
        <div className="capture-hud__header-actions">
          <button type="button" className="capture-hud__record" disabled={busy || loading} onClick={() => void openRecordingStudio()}>
            <i aria-hidden="true" />
            Record
          </button>
          <button type="button" className="capture-hud__close" aria-label="Close capture controls" onClick={() => void dismiss()}>
            <span aria-hidden="true">×</span>
          </button>
        </div>
      </header>

      <section className="capture-hud__section" aria-labelledby="capture-mode-label">
        <div className="capture-hud__section-heading">
          <h2 id="capture-mode-label">What to capture</h2>
          <span>Use ← → to switch</span>
        </div>
        <div className="capture-hud__modes" role="radiogroup" aria-label="Capture mode">
          {CAPTURE_MODES.map((mode) => {
            const selected = settings.mode === mode;
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                data-mode={mode}
                className="capture-hud__mode"
                disabled={busy || loading}
                onClick={() =>
                  setSettings((current) => ({
                    ...current,
                    mode,
                    freezeScreen: mode === "region" && current.freezeScreen,
                  }))
                }
                onKeyDown={(event) => moveMode(event, event.key === "ArrowLeft" ? -1 : 1)}
              >
                <span className={`capture-hud__mode-icon capture-hud__mode-icon--${mode}`} aria-hidden="true">
                  <i />
                </span>
                <strong>{modeLabel(mode)}</strong>
                <small>{MODE_DETAIL[mode]}</small>
              </button>
            );
          })}
        </div>
      </section>

      {settings.mode === "window" && (
        <section className="capture-hud__window-options" aria-label="Window finish">
          <label className="capture-hud__shadow">
            <input
              type="checkbox"
              aria-label="Include window shadow"
              checked={settings.windowShadow}
              disabled={busy || loading}
              onChange={(event) =>
                setSettings((current) => ({ ...current, windowShadow: event.target.checked }))
              }
            />
            <span aria-hidden="true"><i /></span>
            <strong>Shadow</strong>
          </label>
          <label>
            <span>Padding</span>
            <select
              aria-label="Window padding"
              value={settings.windowPadding}
              disabled={busy || loading}
              onChange={(event) => setSettings((current) => ({
                ...current,
                windowPadding: Number(event.target.value) as WindowPadding,
              }))}
            >
              {WINDOW_PADDINGS.map((padding) => (
                <option key={padding} value={padding}>{padding === 0 ? "None" : `${padding} px`}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Background</span>
            <select
              aria-label="Window background"
              value={settings.windowBackground}
              disabled={busy || loading}
              onChange={(event) => setSettings((current) => ({
                ...current,
                windowBackground: event.target.value as WindowBackground,
              }))}
            >
              {WINDOW_BACKGROUNDS.map((background) => (
                <option key={background} value={background}>{WINDOW_BACKGROUND_LABEL[background]}</option>
              ))}
            </select>
          </label>
          {settings.windowBackground === "custom" && (
            <label className="capture-hud__custom-background">
              <span>Colour</span>
              <input
                type="color"
                aria-label="Custom window background"
                value={settings.windowCustomBackground}
                disabled={busy || loading}
                onChange={(event) => setSettings((current) => ({
                  ...current,
                  windowCustomBackground: event.target.value.toUpperCase(),
                }))}
              />
            </label>
          )}
        </section>
      )}

      <section className="capture-hud__section capture-hud__section--delay" aria-labelledby="capture-delay-label">
        <div className="capture-hud__section-heading">
          <h2 id="capture-delay-label">Delay</h2>
          <div className="capture-hud__capture-options">
            <label className="capture-hud__freeze" data-disabled={settings.mode !== "region"}>
              <input
                type="checkbox"
                checked={settings.freezeScreen}
                disabled={busy || loading || settings.mode !== "region"}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    freezeScreen: current.mode === "region" && event.target.checked,
                  }))
                }
              />
              <span aria-hidden="true"><i /></span>
              <strong>Freeze main display</strong>
            </label>
            <label className="capture-hud__freeze">
              <input
                type="checkbox"
                aria-label="Hide desktop icons while capturing"
                checked={settings.hideDesktopIcons}
                disabled={busy || loading}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    hideDesktopIcons: event.target.checked,
                  }))
                }
              />
              <span aria-hidden="true"><i /></span>
              <strong>Desktop icons</strong>
            </label>
          </div>
        </div>
        <div className="capture-hud__delays" role="radiogroup" aria-label="Capture delay">
          {CAPTURE_DELAYS.map((delay) => {
            const selected = settings.delaySeconds === delay;
            return (
              <button
                key={delay}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={delayLabel(delay)}
                tabIndex={selected ? 0 : -1}
                data-delay={delay}
                disabled={busy || loading}
                onClick={() =>
                  setSettings((current) => ({ ...current, delaySeconds: delay as CaptureDelay }))
                }
                onKeyDown={(event) => moveDelay(event, event.key === "ArrowLeft" ? -1 : 1)}
              >
                {delay === 0 ? "Off" : `${delay}s`}
              </button>
            );
          })}
        </div>
      </section>

      {(storageWarning || desktopClutterWarning || error) && (
        <p className="capture-hud__feedback" role="status">
          {error ?? desktopClutterWarning ?? storageWarning}
        </p>
      )}

      <footer className="capture-hud__footer">
        <button
          type="button"
          className="capture-hud__previous"
          disabled={busy || loading || !previousArea.available}
          aria-label={
            previousArea.available
              ? `Capture Previous area ${previousArea.label ?? ""}`
              : `Previous area unavailable. ${previousArea.unavailableReason ?? "Choose Area first."}`
          }
          title={previousArea.unavailableReason ?? "Capture the same area now"}
          onClick={() => void startPreviousArea()}
        >
          <span>Previous area</span>
          <small>{previousArea.label ?? "Choose Area first"}</small>
        </button>
        <button type="button" className="capture-hud__start" disabled={busy || loading} onClick={() => void startCapture()}>
          <span>
            {busy
              ? "Starting…"
              : settings.freezeScreen
                ? "Freeze & capture Area"
                : `Capture ${modeLabel(settings.mode)}`}
          </span>
          <kbd>⌘↵</kbd>
        </button>
      </footer>
    </main>
  );
}
