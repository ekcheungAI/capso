import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState } from "react";
import { microphoneReadiness, type RecordingCapabilities } from "./recording-microphone";

type RecordingMode = "area" | "window" | "fullscreen";
type RecordingQuality = "source" | "full_hd" | "hd";
type EditorOutputFormat = "mp4" | "gif";
type GifWidth = 480 | 720 | 960;
type GifFrameRate = 8 | 12 | 15;
type RecordingRequest = {
  mode: RecordingMode;
  quality: RecordingQuality;
  microphone: boolean;
  microphoneDeviceId: string | null;
  showClicks: boolean;
  showCursor: boolean;
  hideDesktopIcons: boolean;
};
type RecordingOutput = {
  id: string;
  path: string;
  bytes: number;
  format: "mp4" | "gif" | "mov_recovery" | "mov_interrupted";
  modifiedAtMs: number;
};
type RecordingSnapshot = {
  status: "idle" | "selecting" | "recording" | "finalizing" | "completed" | "cancelled" | "failed";
  sessionId: number | null;
  mode: RecordingMode | null;
  quality: RecordingQuality | null;
  microphone: boolean;
  microphoneDeviceId: string | null;
  showClicks: boolean;
  showCursor: boolean;
  hideDesktopIcons: boolean;
  startedAtMs: number | null;
  output: RecordingOutput | null;
  recordings: RecordingOutput[];
  historyWarning: string | null;
  desktopClutterWarning: string | null;
  message: string | null;
};

const parameters = new URLSearchParams(window.location.search);
const previewState = parameters.get("state");
const PREVIEW_OUTPUT: RecordingOutput = {
  id: "00000000-0000-0000-0000-000000000001.mp4",
  path: "/Users/demo/Library/Application Support/Capso/recordings/demo.mp4",
  bytes: 18_420_000,
  format: "mp4",
  modifiedAtMs: Date.now() - 180_000,
};
const PREVIEW_RECOVERY: RecordingOutput = {
  id: "00000000-0000-0000-0000-000000000002.interrupted.mov",
  path: "/Users/demo/Library/Application Support/Capso/recordings/recovered.mov",
  bytes: 8_120_000,
  format: "mov_interrupted",
  modifiedAtMs: Date.now() - 86_400_000,
};
const PREVIEW_CAPABILITIES: RecordingCapabilities = {
  microphonePermission: "authorized",
  microphoneDevices: [
    { id: "built-in", name: "MacBook Microphone", isDefault: true },
    { id: "usb-mic", name: "USB Microphone", isDefault: false },
  ],
};
const PREVIEW_SNAPSHOT: RecordingSnapshot = previewState === "recording"
  ? {
      status: "recording",
      sessionId: 1,
      mode: "area",
      quality: "source",
      microphone: true,
      microphoneDeviceId: "built-in",
      showClicks: true,
      showCursor: true,
      hideDesktopIcons: true,
      startedAtMs: Date.now() - 74_000,
      output: null,
      recordings: [PREVIEW_OUTPUT, PREVIEW_RECOVERY],
      historyWarning: null,
      desktopClutterWarning: null,
      message: null,
    }
  : previewState === "completed"
    ? {
        status: "completed",
        sessionId: 1,
        mode: null,
        quality: null,
        microphone: false,
        microphoneDeviceId: null,
        showClicks: false,
        showCursor: false,
        hideDesktopIcons: false,
        startedAtMs: null,
        output: PREVIEW_OUTPUT,
        recordings: [PREVIEW_OUTPUT, PREVIEW_RECOVERY],
        historyWarning: null,
        desktopClutterWarning: null,
        message: "MP4 saved locally.",
      }
    : {
        status: "idle",
        sessionId: null,
        mode: null,
        quality: null,
        microphone: false,
        microphoneDeviceId: null,
        showClicks: false,
        showCursor: false,
        hideDesktopIcons: false,
        startedAtMs: null,
        output: null,
        recordings: [PREVIEW_OUTPUT, PREVIEW_RECOVERY],
        historyWarning: null,
        desktopClutterWarning: null,
        message: null,
      };

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

function formatElapsed(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes.toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1_048_576) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1_048_576).toFixed(bytes < 10_485_760 ? 1 : 0)} MB`;
}

function formatRecordingTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function recordingFormatLabel(format: RecordingOutput["format"]) {
  if (format === "mp4") return "MP4";
  if (format === "gif") return "GIF";
  return "Recovery MOV";
}

function recordingActionLabel(
  action: "Open" | "Show in Finder" | "Edit",
  recording: RecordingOutput,
) {
  return `${action} ${recordingFormatLabel(recording.format)} recorded ${formatRecordingTime(recording.modifiedAtMs)}`;
}

export default function RecordingStudio() {
  const nativeRuntime = useMemo(isTauriRuntime, []);
  const actionInFlight = useRef(false);
  const [request, setRequest] = useState<RecordingRequest>({
    mode: "area",
    quality: "source",
    microphone: false,
    microphoneDeviceId: null,
    showClicks: false,
    showCursor: true,
    hideDesktopIcons: false,
  });
  const [snapshot, setSnapshot] = useState<RecordingSnapshot>(() =>
    nativeRuntime
      ? { ...PREVIEW_SNAPSHOT, status: "idle", output: null, recordings: [], historyWarning: null }
      : PREVIEW_SNAPSHOT,
  );
  const [capabilities, setCapabilities] = useState<RecordingCapabilities>(PREVIEW_CAPABILITIES);
  const [loading, setLoading] = useState(nativeRuntime);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clock, setClock] = useState(Date.now());
  const [editing, setEditing] = useState<RecordingOutput | null>(() =>
    !nativeRuntime && previewState === "editor" ? PREVIEW_OUTPUT : null,
  );
  const [durationMs, setDurationMs] = useState(
    !nativeRuntime && previewState === "editor" ? 75_000 : 0,
  );
  const [trimStartMs, setTrimStartMs] = useState(0);
  const [trimEndMs, setTrimEndMs] = useState(
    !nativeRuntime && previewState === "editor" ? 75_000 : 0,
  );
  const [editQuality, setEditQuality] = useState<RecordingQuality>("source");
  const [editFormat, setEditFormat] = useState<EditorOutputFormat>("mp4");
  const [gifWidth, setGifWidth] = useState<GifWidth>(720);
  const [gifFrameRate, setGifFrameRate] = useState<GifFrameRate>(12);
  const [gifLoopForever, setGifLoopForever] = useState(true);

  useEffect(() => {
    if (!nativeRuntime) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void (async () => {
      unlisten = await listen<RecordingSnapshot>("recording-status-changed", ({ payload }) => {
        if (disposed) return;
        setSnapshot(payload);
        setError(null);
      });
      const [current, recordingCapabilities] = await Promise.all([
        invoke<RecordingSnapshot>("get_recording_status"),
        invoke<RecordingCapabilities>("get_recording_capabilities"),
      ]);
      if (!disposed) {
        setSnapshot(current);
        setCapabilities(recordingCapabilities);
      }
    })()
      .catch((reason) => {
        if (!disposed) setError(`Could not load recording controls: ${String(reason)}`);
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [nativeRuntime]);

  useEffect(() => {
    if (!nativeRuntime) return;
    let disposed = false;
    const refreshCapabilities = () => {
      void invoke<RecordingCapabilities>("get_recording_capabilities")
        .then((next) => {
          if (!disposed) setCapabilities(next);
        })
        .catch(() => undefined);
    };
    window.addEventListener("focus", refreshCapabilities);
    return () => {
      disposed = true;
      window.removeEventListener("focus", refreshCapabilities);
    };
  }, [nativeRuntime]);

  useEffect(() => {
    if (snapshot.status !== "recording") return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [snapshot.status, snapshot.startedAtMs]);

  const active = snapshot.status === "selecting" || snapshot.status === "recording";
  const finalizing = snapshot.status === "finalizing";
  const canConfigure = !loading && !busy && !active && !finalizing;
  const microphoneState = microphoneReadiness(
    request.microphone,
    request.microphoneDeviceId,
    capabilities,
  );
  const selectedMicrophoneMissing = microphoneState.selectedMissing;
  const selectedMicrophoneName = microphoneState.selectedName;
  const canStart = canConfigure && microphoneState.ready;
  const elapsed = snapshot.startedAtMs === null ? "00:00" : formatElapsed(clock - snapshot.startedAtMs);
  const editorSource = editing && nativeRuntime ? convertFileSrc(editing.path) : null;
  const activeMicrophoneName = snapshot.microphoneDeviceId === null
    ? capabilities.microphoneDevices.find((device) => device.isDefault)?.name ?? "System default"
    : capabilities.microphoneDevices.find((device) => device.id === snapshot.microphoneDeviceId)?.name
      ?? "Selected microphone";

  function beginAction() {
    if (actionInFlight.current) return false;
    actionInFlight.current = true;
    setBusy(true);
    setError(null);
    return true;
  }

  function endAction() {
    actionInFlight.current = false;
    setBusy(false);
  }

  async function requestMicrophoneAccess() {
    if (!canConfigure || !beginAction()) return;
    try {
      const next = await invoke<RecordingCapabilities>("request_recording_microphone_access");
      setCapabilities(next);
      if (next.microphonePermission !== "authorized") {
        setError("Microphone access is required before recording audio.");
      }
    } catch (reason) {
      setError(`Could not request microphone access: ${String(reason)}`);
    } finally {
      endAction();
    }
  }

  async function openMicrophoneSettings() {
    if (!canConfigure || !beginAction()) return;
    try {
      await invoke("open_recording_microphone_settings");
    } catch (reason) {
      setError(`Could not open Microphone settings: ${String(reason)}`);
    } finally {
      endAction();
    }
  }

  async function startRecording() {
    if (!canStart || !beginAction()) return;
    if (!nativeRuntime) {
      setSnapshot({
        status: "selecting",
        sessionId: 1,
        mode: request.mode,
        quality: request.quality,
        microphone: request.microphone,
        microphoneDeviceId: request.microphoneDeviceId,
        showClicks: request.showClicks,
        showCursor: request.showCursor,
        hideDesktopIcons: request.hideDesktopIcons,
        startedAtMs: null,
        output: null,
        recordings: snapshot.recordings,
        historyWarning: snapshot.historyWarning,
        desktopClutterWarning: snapshot.desktopClutterWarning,
        message: null,
      });
      endAction();
      return;
    }
    try {
      const status = await invoke<RecordingSnapshot>("start_recording", { request });
      setSnapshot(status);
    } catch (reason) {
      setError(`Could not start recording: ${String(reason)}`);
    } finally {
      endAction();
    }
  }

  async function stopRecording() {
    if (!nativeRuntime || snapshot.sessionId === null || !active || !beginAction()) return;
    const sessionId = snapshot.sessionId;
    try {
      await invoke("stop_recording", { sessionId });
      setSnapshot((current) => current.sessionId === sessionId
        && (current.status === "selecting" || current.status === "recording")
        ? { ...current, status: "finalizing", message: null }
        : current);
    } catch (reason) {
      setError(`Could not stop recording: ${String(reason)}`);
    } finally {
      endAction();
    }
  }

  async function outputAction(
    command: "open_recording_output" | "reveal_recording_output",
    id: string,
  ) {
    if (!nativeRuntime || !beginAction()) return;
    try {
      await invoke(command, { id });
    } catch (reason) {
      setError(`${command === "open_recording_output"
        ? "Could not open recording"
        : "Could not show recording in Finder"}: ${String(reason)}`);
    } finally {
      endAction();
    }
  }

  async function closeStudio() {
    if (!nativeRuntime) return;
    try {
      await invoke("hide_recording_studio");
    } catch (reason) {
      setError(`Could not close recording controls: ${String(reason)}`);
    }
  }

  function openEditor(recording: RecordingOutput) {
    if (recording.format !== "mp4" || busy || actionInFlight.current) return;
    setError(null);
    setEditing(recording);
    setDurationMs(nativeRuntime ? 0 : 75_000);
    setTrimStartMs(0);
    setTrimEndMs(nativeRuntime ? 0 : 75_000);
    setEditQuality("source");
    setEditFormat("mp4");
    setGifWidth(720);
    setGifFrameRate(12);
    setGifLoopForever(true);
  }

  async function saveTrimmedCopy() {
    if (!nativeRuntime || !editing || durationMs <= 0 || trimEndMs - trimStartMs < 250 || !beginAction()) return;
    try {
      await invoke<RecordingOutput>("trim_recording", {
        id: editing.id,
        startMs: trimStartMs,
        endMs: trimEndMs,
        quality: editQuality,
      });
      const current = await invoke<RecordingSnapshot>("get_recording_status");
      setSnapshot(current);
      setEditing(null);
    } catch (reason) {
      setError(`Could not save trimmed recording: ${String(reason)}`);
    } finally {
      endAction();
    }
  }

  async function exportGifCopy() {
    const keptMs = trimEndMs - trimStartMs;
    if (!nativeRuntime || !editing || durationMs <= 0 || keptMs < 250 || keptMs > 30_000 || !beginAction()) return;
    try {
      await invoke<RecordingOutput>("export_recording_gif", {
        id: editing.id,
        startMs: trimStartMs,
        endMs: trimEndMs,
        width: gifWidth,
        framesPerSecond: gifFrameRate,
        loopForever: gifLoopForever,
      });
      const current = await invoke<RecordingSnapshot>("get_recording_status");
      setSnapshot(current);
      setEditing(null);
    } catch (reason) {
      setError(`Could not export GIF copy: ${String(reason)}`);
    } finally {
      endAction();
    }
  }

  return (
    <main className="recording-studio" aria-labelledby="recording-title" aria-busy={busy || loading}>
      <header className="recording-studio__header">
        <div>
          <span>CAPSO RECORD</span>
          <h1 id="recording-title">Screen recording</h1>
        </div>
        <button type="button" aria-label="Close recording controls" onClick={() => void closeStudio()}>×</button>
      </header>

      {active || finalizing ? (
        <section className="recording-studio__active" aria-live="polite">
          <div className="recording-studio__pulse" data-recording={snapshot.status === "recording"} aria-hidden="true"><i /></div>
          <span>{snapshot.status === "selecting" ? "APPLE PICKER" : finalizing ? "LOCAL EXPORT" : "RECORDING"}</span>
          <strong>{snapshot.status === "selecting" ? "Choose an area or screen" : finalizing ? "Finishing local copy…" : elapsed}</strong>
          <p>
            {snapshot.status === "selecting"
              ? "Use the macOS picker. Escape cancels before any video is published."
              : finalizing
                ? "Capso is exporting locally and filtering source metadata."
                : `${snapshot.microphone ? `Mic · ${activeMicrophoneName}` : "No microphone"} · ${snapshot.showClicks ? "Clicks visible" : "Clicks hidden"} · ${snapshot.mode === "fullscreen" ? snapshot.showCursor ? "Pointer visible" : "Pointer hidden" : "Pointer via Apple picker"} · ${snapshot.hideDesktopIcons ? "Desktop icons hidden" : "Desktop unchanged"}`}
          </p>
          {active && (
            <button type="button" className="recording-studio__stop" disabled={busy} onClick={() => void stopRecording()}>
              <i aria-hidden="true" />
              {snapshot.status === "selecting" ? "Cancel selection" : "Stop and save"}
            </button>
          )}
        </section>
      ) : editing ? (
        <section className="recording-studio__editor" aria-labelledby="recording-editor-title">
          <div className="recording-studio__section-heading">
            <h2 id="recording-editor-title">Edit recording</h2>
            <span>Source stays unchanged</span>
          </div>
          {editorSource ? (
            <video
              src={editorSource}
              controls
              preload="metadata"
              onLoadedMetadata={(event) => {
                const milliseconds = Math.min(7_200_000, Math.round(event.currentTarget.duration * 1_000));
                if (!Number.isFinite(milliseconds) || milliseconds < 250) {
                  setError("This MP4 has no safe editable duration.");
                  return;
                }
                setDurationMs(milliseconds);
                setTrimStartMs(0);
                setTrimEndMs(milliseconds);
              }}
              onError={() => setError("The local MP4 could not be previewed for trimming.")}
            />
          ) : (
            <div className="recording-studio__video-preview" aria-label="Local video preview">
              <i aria-hidden="true" />
              <span>Local MP4 playback</span>
            </div>
          )}
          <div className="recording-studio__trim-summary" aria-live="polite">
            <strong>{formatElapsed(trimStartMs)} → {formatElapsed(trimEndMs)}</strong>
            <span>{formatElapsed(Math.max(0, trimEndMs - trimStartMs))} kept</span>
            <label>
              <span>Format</span>
              <select
                aria-label="Editor output format"
                value={editFormat}
                disabled={busy}
                onChange={(event) => {
                  const format = event.currentTarget.value as EditorOutputFormat;
                  setEditFormat(format);
                  if (format === "gif") {
                    setTrimEndMs((current) => Math.min(current, trimStartMs + 30_000));
                  }
                }}
              >
                <option value="mp4">MP4 copy</option>
                <option value="gif">GIF copy</option>
              </select>
            </label>
            {editFormat === "mp4" && (
              <label>
                <span>Quality</span>
                <select
                  aria-label="Edited copy quality"
                  value={editQuality}
                  disabled={busy}
                  onChange={(event) => setEditQuality(event.currentTarget.value as RecordingQuality)}
                >
                  <option value="source">Source</option>
                  <option value="full_hd">1080p</option>
                  <option value="hd">720p</option>
                </select>
              </label>
            )}
          </div>
          <label className="recording-studio__trim-range">
            <span>Start</span>
            <input
              type="range"
              aria-label="Trim start"
              min="0"
              max={Math.max(0, durationMs - 250)}
              step="250"
              value={Math.min(trimStartMs, Math.max(0, durationMs - 250))}
              disabled={busy || durationMs < 250}
              onChange={(event) => {
                const nextStart = Number(event.currentTarget.value);
                if (editFormat === "gif") {
                  const keptMs = Math.min(30_000, Math.max(250, trimEndMs - trimStartMs));
                  setTrimEndMs(Math.min(durationMs, nextStart + keptMs));
                } else if (nextStart >= trimEndMs) {
                  setTrimEndMs(Math.min(durationMs, nextStart + 250));
                }
                setTrimStartMs(nextStart);
              }}
            />
          </label>
          <label className="recording-studio__trim-range">
            <span>End</span>
            <input
              type="range"
              aria-label="Trim end"
              min={Math.min(durationMs, trimStartMs + 250)}
              max={Math.max(250, editFormat === "gif" ? Math.min(durationMs, trimStartMs + 30_000) : durationMs)}
              step="250"
              value={Math.max(trimStartMs + 250, trimEndMs)}
              disabled={busy || durationMs < 250}
              onChange={(event) => setTrimEndMs(Number(event.currentTarget.value))}
            />
          </label>
          {editFormat === "gif" && (
            <div className="recording-studio__gif-options" aria-label="GIF export options">
              <label>
                <span>Width</span>
                <select
                  aria-label="GIF width"
                  value={gifWidth}
                  disabled={busy}
                  onChange={(event) => setGifWidth(Number(event.currentTarget.value) as GifWidth)}
                >
                  <option value="480">480 px</option>
                  <option value="720">720 px</option>
                  <option value="960">960 px</option>
                </select>
              </label>
              <label>
                <span>Motion</span>
                <select
                  aria-label="GIF frame rate"
                  value={gifFrameRate}
                  disabled={busy}
                  onChange={(event) => setGifFrameRate(Number(event.currentTarget.value) as GifFrameRate)}
                >
                  <option value="8">8 fps · Small</option>
                  <option value="12">12 fps · Balanced</option>
                  <option value="15">15 fps · Smooth</option>
                </select>
              </label>
              <label className="recording-studio__gif-loop">
                <input
                  type="checkbox"
                  aria-label="Loop GIF forever"
                  checked={gifLoopForever}
                  disabled={busy}
                  onChange={(event) => setGifLoopForever(event.currentTarget.checked)}
                />
                <span>Loop forever</span>
              </label>
            </div>
          )}
          <div className="recording-studio__editor-actions">
            <button type="button" disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
            <button
              type="button"
              disabled={
                busy
                || !nativeRuntime
                || durationMs < 250
                || trimEndMs - trimStartMs < 250
                || (editFormat === "gif" && trimEndMs - trimStartMs > 30_000)
              }
              onClick={() => void (editFormat === "gif" ? exportGifCopy() : saveTrimmedCopy())}
            >
              {busy ? "Saving…" : editFormat === "gif" ? "Export GIF copy" : "Save trimmed copy"}
            </button>
          </div>
          <p>
            {editFormat === "gif"
              ? "Creates a silent GIF up to 30 seconds. The original MP4 is never overwritten."
              : "Creates a new H.264 MP4. The original local recording is never overwritten."}
          </p>
        </section>
      ) : (
        <>
          <section className="recording-studio__setup" aria-labelledby="recording-area-label">
            <div className="recording-studio__section-heading">
              <h2 id="recording-area-label">Recording area</h2>
              <span>H.264 MP4 · up to 2 hours</span>
            </div>
            <div className="recording-studio__modes" role="radiogroup" aria-label="Recording area">
              {([
                ["area", "Area", "Choose with Apple’s picker"],
                ["window", "Window", "Pick one app window"],
                ["fullscreen", "Full screen", "Main display immediately"],
              ] as const).map(([mode, label, detail]) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={request.mode === mode}
                  disabled={!canConfigure}
                  onClick={() => setRequest((current) => ({
                    ...current,
                    mode,
                    showCursor: mode === "fullscreen" ? current.showCursor : true,
                  }))}
                >
                  <i aria-hidden="true" data-mode={mode} />
                  <strong>{label}</strong>
                  <small>{detail}</small>
                </button>
              ))}
                </div>
                <label className="recording-studio__quality">
                  <span>Export quality</span>
                  <select
                    aria-label="Recording quality"
                    value={request.quality}
                    disabled={!canConfigure}
                    onChange={(event) => setRequest((current) => ({
                      ...current,
                      quality: event.target.value as RecordingQuality,
                    }))}
                  >
                    <option value="source">Source</option>
                    <option value="full_hd">1080p</option>
                    <option value="hd">720p</option>
                  </select>
                </label>
              </section>

          <section className="recording-studio__options" aria-label="Recording options">
            <label>
              <input
                type="checkbox"
                aria-label="Include microphone"
                checked={request.microphone}
                disabled={!canConfigure}
                onChange={(event) => setRequest((current) => ({ ...current, microphone: event.target.checked }))}
              />
              <span aria-hidden="true"><i /></span>
              <strong>Microphone</strong>
              <small>{request.microphone ? selectedMicrophoneName : "Optional input"}</small>
            </label>
            <label>
              <input
                type="checkbox"
                aria-label="Show pointer clicks"
                checked={request.showClicks}
                disabled={!canConfigure}
                onChange={(event) => setRequest((current) => ({ ...current, showClicks: event.target.checked }))}
              />
              <span aria-hidden="true"><i /></span>
              <strong>Pointer clicks</strong>
              <small>Click rings</small>
            </label>
            <label title={request.mode === "fullscreen" ? "Full-screen only" : "Pointer visibility is managed by the Apple picker"}>
              <input
                type="checkbox"
                aria-label="Include pointer in full-screen recording"
                checked={request.mode === "fullscreen" && request.showCursor}
                disabled={!canConfigure || request.mode !== "fullscreen"}
                onChange={(event) => setRequest((current) => ({
                  ...current,
                  showCursor: event.target.checked,
                }))}
              />
              <span aria-hidden="true"><i /></span>
              <strong>Pointer</strong>
              <small>{request.mode === "fullscreen" ? "Full screen" : "Picker"}</small>
            </label>
            <label>
              <input
                type="checkbox"
                aria-label="Hide desktop icons while recording"
                checked={request.hideDesktopIcons}
                disabled={!canConfigure}
                onChange={(event) => setRequest((current) => ({
                  ...current,
                  hideDesktopIcons: event.target.checked,
                }))}
              />
              <span aria-hidden="true"><i /></span>
              <strong>Desktop icons</strong>
              <small>Restore when done</small>
            </label>
          </section>

          {request.microphone && (
            <section className="recording-studio__microphone" aria-label="Microphone setup">
              <div>
                <strong>Microphone source</strong>
                <small>Microphone only · System audio is not included</small>
              </div>
              {capabilities.microphonePermission === "authorized"
                && capabilities.microphoneDevices.length > 0 ? (
                <select
                  aria-label="Microphone source"
                  value={request.microphoneDeviceId ?? ""}
                  disabled={!canConfigure}
                  onChange={(event) => setRequest((current) => ({
                    ...current,
                    microphoneDeviceId: event.target.value || null,
                  }))}
                >
                  <option value="">System default</option>
                  {selectedMicrophoneMissing && request.microphoneDeviceId && (
                    <option value={request.microphoneDeviceId}>Disconnected source</option>
                  )}
                  {capabilities.microphoneDevices.map((device) => (
                    <option key={device.id} value={device.id}>
                      {device.name}{device.isDefault ? " · Default" : ""}
                    </option>
                  ))}
                </select>
              ) : capabilities.microphonePermission === "not_determined" ? (
                <button type="button" disabled={!canConfigure} onClick={() => void requestMicrophoneAccess()}>
                  Allow microphone
                </button>
              ) : capabilities.microphonePermission === "denied"
                || capabilities.microphonePermission === "restricted" ? (
                <button type="button" disabled={!canConfigure} onClick={() => void openMicrophoneSettings()}>
                  Open System Settings
                </button>
              ) : (
                <span>Unavailable</span>
              )}
              {capabilities.microphonePermission === "not_determined" && (
                <p role="status">Microphone access is required before recording audio.</p>
              )}
              {capabilities.microphonePermission === "authorized"
                && capabilities.microphoneDevices.length === 0 && (
                <p role="status">No recording microphone is currently connected.</p>
              )}
              {selectedMicrophoneMissing && (
                <p role="status">The selected microphone is no longer connected. Choose another source.</p>
              )}
            </section>
          )}

              {snapshot.output && (
                <section className="recording-studio__output" aria-label="Finished recording">
              <div>
                <span>{recordingFormatLabel(snapshot.output.format)} READY</span>
                <strong>{formatBytes(snapshot.output.bytes)}</strong>
              </div>
                  <button type="button" aria-label={recordingActionLabel("Open", snapshot.output)} disabled={busy} onClick={() => void outputAction("open_recording_output", snapshot.output!.id)}>Open</button>
                  <button type="button" aria-label={recordingActionLabel("Show in Finder", snapshot.output)} disabled={busy} onClick={() => void outputAction("reveal_recording_output", snapshot.output!.id)}>Show in Finder</button>
                  {snapshot.output.format === "mp4" && <button type="button" aria-label={recordingActionLabel("Edit", snapshot.output)} disabled={busy} onClick={() => openEditor(snapshot.output!)}>Edit</button>}
                </section>
              )}

              <button type="button" className="recording-studio__start" disabled={!canStart} onClick={() => void startRecording()}>
                <i aria-hidden="true" />
                {busy ? "Starting…" : "Start recording"}
              </button>
              <p className="recording-studio__privacy">Saved locally first. No recording is uploaded automatically.</p>

              {snapshot.recordings.filter((recording) => recording.id !== snapshot.output?.id).length > 0 && (
                <section className="recording-studio__history" aria-labelledby="recent-recordings-title">
                  <div className="recording-studio__section-heading">
                    <h2 id="recent-recordings-title">Recent recordings</h2>
                    <span>Newest local files</span>
                  </div>
                  <div className="recording-studio__history-list" role="list">
                    {snapshot.recordings
                      .filter((recording) => recording.id !== snapshot.output?.id)
                      .slice(0, 4)
                      .map((recording) => (
                        <article key={recording.id} role="listitem">
                          <div>
                            <strong>{recordingFormatLabel(recording.format)}</strong>
                            <small>{formatRecordingTime(recording.modifiedAtMs)} · {formatBytes(recording.bytes)}</small>
                          </div>
                              <button type="button" aria-label={recordingActionLabel("Open", recording)} disabled={busy} onClick={() => void outputAction("open_recording_output", recording.id)}>Open</button>
                              <button type="button" aria-label={recordingActionLabel("Show in Finder", recording)} disabled={busy} onClick={() => void outputAction("reveal_recording_output", recording.id)}>Finder</button>
                              {recording.format === "mp4" && <button type="button" aria-label={recordingActionLabel("Edit", recording)} disabled={busy} onClick={() => openEditor(recording)}>Edit</button>}
                        </article>
                      ))}
                  </div>
                </section>
              )}
        </>
      )}

          {(error || snapshot.desktopClutterWarning || snapshot.message || snapshot.historyWarning) && !active && (
            <p
              className="recording-studio__feedback"
              role="status"
              data-kind={
                error || snapshot.desktopClutterWarning || snapshot.historyWarning || snapshot.status === "failed"
                  ? "error"
                  : snapshot.status === "completed"
                    ? "success"
                    : "neutral"
              }
            >
              {error ?? snapshot.desktopClutterWarning ?? snapshot.message ?? snapshot.historyWarning}
            </p>
      )}
    </main>
  );
}
