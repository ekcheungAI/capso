import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type ClipboardStatus =
  | { status: "copied"; bytes: number }
  | { status: "failed"; code: string; message: string };

type OverlayCapture = {
  path: string;
  clipboard: ClipboardStatus;
};

const PREVIEW_CAPTURE: OverlayCapture = {
  path: "",
  clipboard: { status: "copied", bytes: 248_320 },
};

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

export default function CaptureOverlay() {
  const nativeRuntime = useMemo(isTauriRuntime, []);
  const [capture, setCapture] = useState<OverlayCapture | null>(() =>
    nativeRuntime ? null : PREVIEW_CAPTURE,
  );
  const [imageFailed, setImageFailed] = useState(false);
  const revealedPath = useRef<string | null>(null);

  useEffect(() => {
    if (!nativeRuntime) return;

    let disposed = false;
    let receivedLiveCapture = false;
    let unlisten: UnlistenFn | undefined;

    void (async () => {
      unlisten = await listen<OverlayCapture>("overlay-capture", (event) => {
        if (disposed) return;
        receivedLiveCapture = true;
        revealedPath.current = null;
        setImageFailed(false);
        setCapture(event.payload);
      });
      if (disposed) {
        unlisten();
        return;
      }

      const current = await invoke<OverlayCapture | null>("get_overlay_capture");
      if (!disposed && !receivedLiveCapture && current) setCapture(current);
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [nativeRuntime]);

  const reveal = useCallback(() => {
    if (!nativeRuntime || !capture?.path || revealedPath.current === capture.path) {
      return;
    }
    revealedPath.current = capture.path;
    void invoke<boolean>("overlay_image_ready", { path: capture.path }).catch(() => {
      revealedPath.current = null;
    });
  }, [capture?.path, nativeRuntime]);

  if (!capture) {
    return <main className="capture-overlay capture-overlay--waiting" aria-hidden="true" />;
  }

  const source = nativeRuntime && capture.path ? convertFileSrc(capture.path) : null;
  const clipboardCopy =
    capture.clipboard.status === "copied" ? "Copied to clipboard" : "Copy unavailable";

  return (
    <main
      key={capture.path || "preview"}
      className="capture-overlay"
      role="status"
      aria-live="polite"
      aria-label="Latest Capso capture"
    >
      <div className="capture-overlay__preview">
        {source && !imageFailed ? (
          <img
            key={capture.path}
            src={source}
            alt="Latest screenshot"
            draggable={false}
            onLoad={reveal}
            onError={() => {
              setImageFailed(true);
              if (nativeRuntime && capture.path) {
                void invoke<boolean>("overlay_image_failed", {
                  path: capture.path,
                }).catch(() => undefined);
              }
            }}
          />
        ) : imageFailed ? (
          <div className="capture-overlay__fallback">
            <span aria-hidden="true">!</span>
            <strong>Preview unavailable</strong>
            <small>The original is safely stored</small>
          </div>
        ) : (
          <div className="capture-overlay__demo" aria-hidden="true">
            <div className="capture-overlay__demo-bar" />
            <div className="capture-overlay__demo-copy">
              <span />
              <span />
              <span />
            </div>
            <div className="capture-overlay__demo-card" />
          </div>
        )}
      </div>

      <footer className="capture-overlay__footer">
        <span className="capture-overlay__mark" aria-hidden="true" />
        <span className="capture-overlay__message">
          <strong>Capture saved</strong>
          <small>{clipboardCopy}</small>
        </span>
        <span
          className="capture-overlay__state"
          data-warning={capture.clipboard.status === "failed"}
          aria-hidden="true"
        />
      </footer>
    </main>
  );
}
