import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  OverlayActionCoordinator,
  type OverlayActionKind,
} from "./overlay-actions";
import { PausableOverlayTimer } from "./overlay-timing";

type ClipboardStatus =
  | { status: "copied"; bytes: number }
  | { status: "unchanged" }
  | { status: "failed"; code: string; message: string };

type OverlayCapture = {
  path: string;
  presentationId: number;
  clipboard: ClipboardStatus;
  source: "capture" | "history";
};

type PresentedCapture = OverlayCapture & {
  presentation: number;
};

type OverlaySaveResult = {
  destination: string;
  bytes: number;
};

type BusyAction = OverlayActionKind | null;
type DismissReason = "close" | "timeout";

const AUTO_DISMISS_MS = 8_000;
const PREVIEW_IS_HISTORY =
  new URLSearchParams(window.location.search).get("preview") === "history";
const PREVIEW_CAPTURE: PresentedCapture = {
  path: "",
  presentationId: 0,
  clipboard: PREVIEW_IS_HISTORY
    ? { status: "unchanged" }
    : { status: "copied", bytes: 248_320 },
  source: PREVIEW_IS_HISTORY ? "history" : "capture",
  presentation: 0,
};

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

function suggestedFileName() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(".");
  return `Capso ${date} at ${time}.png`;
}

function destinationName(path: string) {
  return path.split(/[\\/]/).pop() || "capture.png";
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="6.5" y="6.5" width="9" height="9" rx="2" />
      <path d="M13 6.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h.5" />
    </svg>
  );
}

function SaveIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 3.5v8" />
      <path d="m6.75 8.75 3.25 3.25 3.25-3.25" />
      <path d="M4 13.5v1A1.5 1.5 0 0 0 5.5 16h9a1.5 1.5 0 0 0 1.5-1.5v-1" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m6 6 8 8M14 6l-8 8" />
    </svg>
  );
}

export default function CaptureOverlay() {
  const nativeRuntime = useMemo(isTauriRuntime, []);
  const [capture, setCapture] = useState<PresentedCapture | null>(() =>
    nativeRuntime ? null : PREVIEW_CAPTURE,
  );
  const [imageFailed, setImageFailed] = useState(false);
  const [imageReady, setImageReady] = useState(!nativeRuntime);
  const [hovered, setHovered] = useState(false);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeIsWarning, setNoticeIsWarning] = useState(false);
  const revealedPresentation = useRef<number | null>(null);
  const actionCoordinator = useRef<OverlayActionCoordinator | null>(null);
  if (actionCoordinator.current === null) {
    actionCoordinator.current = new OverlayActionCoordinator(
      nativeRuntime ? null : PREVIEW_CAPTURE.path,
    );
  }
  const dismissRef = useRef<(reason: DismissReason) => void>(() => undefined);
  const autoDismiss = useRef<PausableOverlayTimer | null>(null);
  if (autoDismiss.current === null) {
    autoDismiss.current = new PausableOverlayTimer(
      AUTO_DISMISS_MS,
      () => dismissRef.current("timeout"),
      {
        now: () => performance.now(),
        set: (callback, delayMs) => window.setTimeout(callback, delayMs),
        clear: (handle) => window.clearTimeout(handle),
      },
    );
  }

  useEffect(() => {
    if (!nativeRuntime) return;

    let disposed = false;
    let receivedLiveCapture = false;
    let unlisten: UnlistenFn | undefined;

    void (async () => {
      unlisten = await listen<OverlayCapture>("overlay-capture", (event) => {
        if (disposed) return;
        receivedLiveCapture = true;
        const presentation = actionCoordinator.current!.activateCapture(event.payload.path);
        revealedPresentation.current = null;
        setImageFailed(false);
        setImageReady(false);
        setBusyAction(null);
        setNotice(null);
        setNoticeIsWarning(false);
        setCapture({ ...event.payload, presentation });
      });
      if (disposed) {
        unlisten();
        return;
      }

      const current = await invoke<OverlayCapture | null>("get_overlay_capture");
      if (!disposed && !receivedLiveCapture && current) {
        const presentation = actionCoordinator.current!.activateCapture(current.path);
        setCapture({ ...current, presentation });
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [nativeRuntime]);

  const reveal = useCallback(() => {
    if (
      !nativeRuntime ||
      !capture?.path ||
      revealedPresentation.current === capture.presentation
    ) {
      return;
    }
    const { path, presentation, presentationId } = capture;
    revealedPresentation.current = presentation;
    void invoke<boolean>("overlay_image_ready", { path, presentationId }).catch(() => {
      if (
        actionCoordinator.current?.generation() === presentation &&
        revealedPresentation.current === presentation
      ) {
        revealedPresentation.current = null;
      }
    });
  }, [capture, nativeRuntime]);

  const dismiss = useCallback(
    async (reason: DismissReason) => {
      if (!nativeRuntime || !capture?.path) return;
      const path = capture.path;
      const presentationId = capture.presentationId;
      const action = actionCoordinator.current?.begin(path, "dismiss");
      if (!action) return;
      setBusyAction("dismiss");
      try {
        const dismissed = await invoke<boolean>("overlay_dismiss", {
          path,
          presentationId,
          reason,
        });
        if (dismissed && actionCoordinator.current?.dismiss(action)) {
          setBusyAction(null);
          setCapture((current) =>
            current?.presentation === action.captureGeneration ? null : current,
          );
        }
      } catch (error) {
        if (actionCoordinator.current?.isCurrent(action)) {
          setNotice(`Could not close: ${String(error)}`);
          setNoticeIsWarning(true);
        }
      } finally {
        if (actionCoordinator.current?.finish(action)) setBusyAction(null);
      }
    },
    [capture?.path, capture?.presentationId, nativeRuntime],
  );

  useEffect(() => {
    dismissRef.current = (reason) => void dismiss(reason);
  }, [dismiss]);

  useEffect(() => {
    autoDismiss.current?.reset();
  }, [capture?.presentation]);

  useEffect(() => {
    const shouldRun =
      nativeRuntime &&
      Boolean(capture?.path) &&
      imageReady &&
      !imageFailed &&
      !hovered &&
      busyAction === null;
    if (shouldRun) autoDismiss.current?.start();
    else autoDismiss.current?.pause();
  }, [busyAction, capture?.path, hovered, imageFailed, imageReady, nativeRuntime]);

  useEffect(() => () => autoDismiss.current?.cancel(), []);

  async function copyCapture() {
    if (!nativeRuntime || !capture?.path) return;
    const path = capture.path;
    const presentationId = capture.presentationId;
    const action = actionCoordinator.current?.begin(path, "copy");
    if (!action) return;
    setBusyAction("copy");
    setNoticeIsWarning(false);
    try {
      const status = await invoke<ClipboardStatus>("overlay_copy_capture", {
        path,
        presentationId,
      });
      if (actionCoordinator.current?.isCurrent(action)) {
        if (status.status === "copied") {
          setCapture((current) =>
            current?.presentation === action.captureGeneration
              ? { ...current, clipboard: status }
              : current,
          );
          setNotice("Copied again");
        } else if (status.status === "failed") {
          setNotice(status.message);
          setNoticeIsWarning(true);
        } else {
          setNotice("Ready to copy");
        }
      }
    } catch (error) {
      if (actionCoordinator.current?.isCurrent(action)) {
        setNotice(`Copy failed: ${String(error)}`);
        setNoticeIsWarning(true);
      }
    } finally {
      if (actionCoordinator.current?.finish(action)) setBusyAction(null);
    }
  }

  async function saveCapture() {
    if (!nativeRuntime || !capture?.path) return;
    const path = capture.path;
    const presentationId = capture.presentationId;
    const action = actionCoordinator.current?.begin(path, "save");
    if (!action) return;
    setBusyAction("save");
    setNoticeIsWarning(false);
    try {
      const destination = await save({
        title: "Save Capso Capture",
        defaultPath: suggestedFileName(),
        filters: [{ name: "PNG image", extensions: ["png"] }],
        canCreateDirectories: true,
      });
      if (!destination) return;

      const result = await invoke<OverlaySaveResult>("overlay_save_capture", {
        path,
        presentationId,
        destination,
      });
      if (actionCoordinator.current?.isCurrent(action)) {
        setNotice(`Saved ${destinationName(result.destination)}`);
      }
    } catch (error) {
      if (actionCoordinator.current?.isCurrent(action)) {
        setNotice(`Save failed: ${String(error)}`);
        setNoticeIsWarning(true);
      }
    } finally {
      if (actionCoordinator.current?.finish(action)) setBusyAction(null);
    }
  }

  if (!capture) {
    return <main className="capture-overlay capture-overlay--waiting" aria-hidden="true" />;
  }

  const source = nativeRuntime && capture.path ? convertFileSrc(capture.path) : null;
  const clipboardCopy =
    capture.clipboard.status === "copied"
      ? "Copied to clipboard"
      : capture.clipboard.status === "unchanged"
        ? "Ready to copy"
        : "Copy unavailable";
  const statusCopy = notice ?? clipboardCopy;
  const isHistory = capture.source === "history";

  return (
    <main
      key={capture.path ? `${capture.path}:${capture.presentationId}` : "preview"}
      className="capture-overlay"
      role="region"
      aria-label={isHistory ? "Restored Capso capture" : "Latest Capso capture"}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <div className="capture-overlay__preview">
        {source && !imageFailed ? (
          <img
            key={`${capture.path}:${capture.presentationId}`}
            src={source}
            alt={isHistory ? "Restored screenshot" : "Latest screenshot"}
            draggable={false}
            onLoad={() => {
              setImageReady(true);
              reveal();
            }}
            onError={() => {
              setImageFailed(true);
              if (nativeRuntime && capture.path) {
                void invoke<boolean>("overlay_image_failed", {
                  path: capture.path,
                  presentationId: capture.presentationId,
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

        <button
          type="button"
          className="capture-overlay__close"
          aria-label="Close capture overlay"
          title="Close"
          disabled={busyAction !== null}
          onClick={() => void dismiss("close")}
        >
          <CloseIcon />
        </button>
      </div>

      <footer className="capture-overlay__footer">
        <span className="capture-overlay__mark" aria-hidden="true" />
        <span className="capture-overlay__message">
          <strong>{isHistory ? "Recent capture" : "Capture saved"}</strong>
          <small data-warning={noticeIsWarning} aria-live="polite">
            {statusCopy}
          </small>
        </span>
        <span className="capture-overlay__actions" role="toolbar" aria-label="Capture actions">
          <button
            type="button"
            className="capture-overlay__action"
            aria-label="Copy capture"
            title="Copy"
            data-busy={busyAction === "copy"}
            disabled={busyAction !== null || imageFailed}
            onClick={() => void copyCapture()}
          >
            <CopyIcon />
          </button>
          <button
            type="button"
            className="capture-overlay__action"
            aria-label="Save capture as PNG"
            title="Save As…"
            data-busy={busyAction === "save"}
            disabled={busyAction !== null || imageFailed}
            onClick={() => void saveCapture()}
          >
            <SaveIcon />
          </button>
        </span>
      </footer>
    </main>
  );
}
