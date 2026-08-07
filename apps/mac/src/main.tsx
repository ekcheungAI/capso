import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import CaptureOverlay from "./CaptureOverlay";

const surface = new URLSearchParams(window.location.search).get("surface");
document.documentElement.dataset.surface = surface ?? "settings";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {surface === "overlay" ? <CaptureOverlay /> : <App />}
  </React.StrictMode>,
);
