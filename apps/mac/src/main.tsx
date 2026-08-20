import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import CaptureOverlay from "./CaptureOverlay";
import AnnotationEditor from "./AnnotationEditor";
import PinCapture from "./PinCapture";
import CaptureTimer from "./CaptureTimer";
import HistoryView from "./HistoryView";
import CaptureHud from "./CaptureHud";
import FreezeScreen from "./FreezeScreen";
import AreaSelector from "./AreaSelector";
import RecordingStudio from "./RecordingStudio";
import { color, type Scheme } from "@capso/shared/tokens";

const parameters = new URLSearchParams(window.location.search);
const surface = parameters.get("surface");
document.documentElement.dataset.surface = surface ?? "settings";

// Browser-only visual QA can force either canonical token scheme. The native
// app continues to follow macOS through `prefers-color-scheme`.
const previewScheme = parameters.get("theme");
if (!("__TAURI_INTERNALS__" in window) && (previewScheme === "light" || previewScheme === "dark")) {
  document.documentElement.style.colorScheme = previewScheme;
  for (const [name, value] of Object.entries(color[previewScheme as Scheme])) {
    document.documentElement.style.setProperty(`--${name}`, value);
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {surface === "overlay" ? (
      <CaptureOverlay />
    ) : surface === "annotate" ? (
      <AnnotationEditor />
    ) : surface === "pin" ? (
      <PinCapture />
    ) : surface === "recording" ? (
      <RecordingStudio />
    ) : surface === "timer" ? (
      <CaptureTimer />
    ) : surface === "capture-hud" ? (
      <CaptureHud />
    ) : surface === "freeze" ? (
      <FreezeScreen />
    ) : surface === "area-selector" ? (
      <AreaSelector />
    ) : surface === "history" ? (
      <HistoryView />
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
