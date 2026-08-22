import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  OverlayActionCoordinator,
  type OverlayActionKind,
  type OverlayActionToken,
} from "./overlay-actions";
import {
  OverlayDragGesture,
  suggestedCaptureFilename,
  type OverlaySaveAsPreferences,
} from "./overlay-drag";
import { OverlaySwipeGesture } from "./overlay-swipe";
import {
  createOverlayAutoDismissTimer,
  PausableOverlayTimer,
} from "./overlay-timing";

type ClipboardStatus =
  | { status: "copied"; bytes: number }
  | { status: "unchanged" }
  | { status: "failed"; code: string; message: string };

type OverlayCapture = {
  path: string;
  presentationId: number;
  clipboard: ClipboardStatus;
  source: "capture" | "history";
  autoDismissMs: number | null;
  quickActions: {
    pin: boolean;
    annotate: boolean;
    copy: boolean;
    save: boolean;
  };
  temporarilyHidden: boolean;
};

type PresentedCapture = OverlayCapture & {
  presentation: number;
};

type OverlaySaveResult = {
  destination: string;
  bytes: number;
  format: "png" | "jpeg";
};

type OverlayDragStarted = {
  bytes: number;
};

type OverlayDragEnded = {
  path: string;
  presentationId: number;
  outcome: "dropped" | "cancelled";
};

type OverlayRestored = {
  path: string;
  presentationId: number;
};

type BusyAction = OverlayActionKind | null;
type DismissReason = "close" | "timeout";
type SwipePhase = "idle" | "tracking" | "settling" | "exiting";

type WebKitWheelEvent = WheelEvent & {
  webkitDirectionInvertedFromDevice?: boolean;
};

const PREVIEW_IS_HISTORY = new URLSearchParams(window.location.search).get("preview") === "history";
const PREVIEW_CAPTURE: PresentedCapture = {
  path: "",
  presentationId: 0,
  clipboard: PREVIEW_IS_HISTORY
    ? { status: "unchanged" }
    : { status: "copied", bytes: 248_320 },
  source: PREVIEW_IS_HISTORY ? "history" : "capture",
  autoDismissMs: 10_000,
  quickActions: { pin: true, annotate: true, copy: true, save: true },
  temporarilyHidden: false,
  presentation: 0,
};

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
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

export default function CaptureOverlay() {
  const nativeRuntime = useMemo(isTauriRuntime, []);
  const [capture, setCapture] = useState<PresentedCapture | null>(() =>
    nativeRuntime ? null : PREVIEW_CAPTURE,
  );
  const [imageFailed, setImageFailed] = useState(false);
  const [imageReady, setImageReady] = useState(!nativeRuntime);
  const [temporarilyHidden, setTemporarilyHidden] = useState(false);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeIsWarning, setNoticeIsWarning] = useState(false);
  const [revealedPresentation, setRevealedPresentation] = useState<number | null>(null);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [swipePhase, setSwipePhase] = useState<SwipePhase>("idle");
  const [reducedMotion, setReducedMotion] = useState(() =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  const overlayElement = useRef<HTMLElement | null>(null);
  const revealRequestedPresentation = useRef<number | null>(null);
  const dragGesture = useRef(new OverlayDragGesture(6));
  const swipeGesture = useRef(new OverlaySwipeGesture());
  const swipeQuietTimer = useRef<number | null>(null);
  const swipeSettleTimer = useRef<number | null>(null);
  const swipeExitTimer = useRef<number | null>(null);
  const dragAction = useRef<{
    token: OverlayActionToken;
    presentationId: number;
  } | null>(null);
  const actionCoordinator = useRef<OverlayActionCoordinator | null>(null);
  if (actionCoordinator.current === null) {
    actionCoordinator.current = new OverlayActionCoordinator(
      nativeRuntime ? null : PREVIEW_CAPTURE.path,
    );
  }
  const dismissRef = useRef<(reason: DismissReason) => void>(() => undefined);
  const autoDismiss = useRef<PausableOverlayTimer | null>(null);

  const clearSwipeTimers = useCallback(() => {
    for (const timer of [swipeQuietTimer, swipeSettleTimer, swipeExitTimer]) {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const resetSwipePresentation = useCallback(() => {
    clearSwipeTimers();
    swipeGesture.current.reset();
    setSwipeOffset(0);
    setSwipePhase("idle");
  }, [clearSwipeTimers]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!nativeRuntime) return;

    let disposed = false;
    let receivedLiveCapture = false;
    let unlisten: UnlistenFn | undefined;
    let unlistenDrag: UnlistenFn | undefined;
    let unlistenHidden: UnlistenFn | undefined;
    let unlistenRestore: UnlistenFn | undefined;

    void (async () => {
      unlisten = await listen<OverlayCapture>("overlay-capture", (event) => {
        if (disposed) return;
        receivedLiveCapture = true;
        resetSwipePresentation();
        dragGesture.current.reset();
        dragAction.current = null;
        const presentation = actionCoordinator.current!.activateCapture(event.payload.path);
        revealRequestedPresentation.current = null;
        setRevealedPresentation(null);
        setImageFailed(false);
        setImageReady(false);
        setTemporarilyHidden(event.payload.temporarilyHidden);
        setBusyAction(null);
        setNotice(null);
        setNoticeIsWarning(false);
        setCapture({ ...event.payload, presentation });
      });
      unlistenDrag = await listen<OverlayDragEnded>("overlay-drag-ended", (event) => {
        if (disposed) return;
        const active = dragAction.current;
        if (
          !active ||
          active.token.path !== event.payload.path ||
          active.presentationId !== event.payload.presentationId ||
          !actionCoordinator.current?.finish(active.token)
        ) {
          return;
        }
        dragAction.current = null;
        setBusyAction(null);
        setNoticeIsWarning(false);
        setNotice(event.payload.outcome === "dropped" ? "Shared a copy" : null);
      });
      unlistenHidden = await listen<OverlayRestored>("overlay-hidden", (event) => {
        if (disposed) return;
        setCapture((current) => {
          if (
            current?.path === event.payload.path &&
            current.presentationId === event.payload.presentationId
          ) {
            autoDismiss.current?.pause();
            setTemporarilyHidden(true);
          }
          return current;
        });
      });
      unlistenRestore = await listen<OverlayRestored>("overlay-restored", (event) => {
        if (disposed) return;
        setCapture((current) => {
          if (
            current?.path === event.payload.path &&
            current.presentationId === event.payload.presentationId
          ) {
            if (autoDismiss.current?.remainingMs() === 0) {
              autoDismiss.current.reset();
            }
            revealRequestedPresentation.current = current.presentation;
            setRevealedPresentation(current.presentation);
            setTemporarilyHidden(false);
            setNotice("Quick Access restored");
            setNoticeIsWarning(false);
          }
          return current;
        });
      });

      if (disposed) {
        unlisten?.();
        unlistenDrag?.();
        unlistenHidden?.();
        unlistenRestore?.();
        return;
      }

      const current = await invoke<OverlayCapture | null>("get_overlay_capture");
      if (!disposed && !receivedLiveCapture && current) {
        resetSwipePresentation();
        const presentation = actionCoordinator.current!.activateCapture(current.path);
        setTemporarilyHidden(current.temporarilyHidden);
        setCapture({ ...current, presentation });
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
      unlistenDrag?.();
      unlistenHidden?.();
      unlistenRestore?.();
    };
  }, [nativeRuntime, resetSwipePresentation]);

  const reveal = useCallback(async () => {
    if (!capture) return;
    if (!nativeRuntime || !capture.path) {
      const presentation = capture.presentation;
      window.requestAnimationFrame(() => setRevealedPresentation(presentation));
      return;
    }
    if (revealRequestedPresentation.current === capture.presentation) return;

    const { path, presentation, presentationId } = capture;
    revealRequestedPresentation.current = presentation;
    try {
      const revealed = await invoke<boolean>("overlay_image_ready", { path, presentationId });
      if (!revealed) {
        if (
          actionCoordinator.current?.generation() === presentation &&
          revealRequestedPresentation.current === presentation
        ) {
          revealRequestedPresentation.current = null;
        }
        return;
      }
      if (
        actionCoordinator.current?.generation() === presentation &&
        revealRequestedPresentation.current === presentation
      ) {
        setRevealedPresentation(presentation);
      }
    } catch {
      if (
        actionCoordinator.current?.generation() === presentation &&
        revealRequestedPresentation.current === presentation
      ) {
        revealRequestedPresentation.current = null;
      }
    }
  }, [capture, nativeRuntime]);

  useEffect(() => {
    if (!nativeRuntime && capture) void reveal();
  }, [capture, nativeRuntime, reveal]);

  const dismiss = useCallback(
    async (reason: DismissReason): Promise<boolean> => {
      if (!capture) return false;
      if (!nativeRuntime || !capture.path) {
        setCapture(null);
        return true;
      }

      const { path, presentationId } = capture;
      const action = actionCoordinator.current?.begin(path, "dismiss");
      if (!action) return false;
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
          return true;
        }
        if (actionCoordinator.current?.isCurrent(action) && reason === "close") {
          setNotice("Could not dismiss this capture yet");
          setNoticeIsWarning(true);
        }
        return false;
      } catch (error) {
        if (actionCoordinator.current?.isCurrent(action)) {
          setNotice(`Could not dismiss: ${String(error)}`);
          setNoticeIsWarning(true);
        }
        return false;
      } finally {
        if (actionCoordinator.current?.finish(action)) setBusyAction(null);
      }
    },
    [capture, nativeRuntime],
  );

  useEffect(() => {
    dismissRef.current = (reason) => void dismiss(reason);
  }, [dismiss]);

  useEffect(() => {
    autoDismiss.current?.cancel();
    autoDismiss.current = createOverlayAutoDismissTimer(
      capture?.autoDismissMs ?? null,
      () => dismissRef.current("timeout"),
      {
        now: () => performance.now(),
        set: (callback, delayMs) => window.setTimeout(callback, delayMs),
        clear: (handle) => window.clearTimeout(handle),
      },
    );
  }, [capture?.autoDismissMs, capture?.presentation]);

  const isRevealed =
    capture !== null &&
    imageReady &&
    !imageFailed &&
    revealedPresentation === capture.presentation;
  useEffect(() => {
    const shouldRun =
      nativeRuntime &&
      Boolean(capture?.path) &&
      capture?.autoDismissMs !== null &&
      imageReady &&
      !imageFailed &&
      isRevealed &&
      !temporarilyHidden &&
      busyAction === null &&
      swipePhase === "idle";
    if (shouldRun) autoDismiss.current?.start();
    else autoDismiss.current?.pause();
  }, [
    busyAction,
    capture?.autoDismissMs,
    capture?.path,
    imageFailed,
    imageReady,
    isRevealed,
    nativeRuntime,
    swipePhase,
    temporarilyHidden,
  ]);

  useEffect(() => () => {
    autoDismiss.current?.cancel();
    clearSwipeTimers();
  }, [clearSwipeTimers]);

  async function copyCapture() {
    if (!capture) return;
    if (!nativeRuntime || !capture.path) {
      setNotice("Copied");
      setNoticeIsWarning(false);
      return;
    }

    const { path, presentationId } = capture;
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
          setNotice("Copied");
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
    if (!capture) return;
    if (!nativeRuntime || !capture.path) {
      setNotice("Saved to your configured folder");
      setNoticeIsWarning(false);
      return;
    }

    const { path, presentationId } = capture;
    const action = actionCoordinator.current?.begin(path, "save");
    if (!action) return;
    setBusyAction("save");
    setNoticeIsWarning(false);
    try {
      const saveAsPreferences = await invoke<OverlaySaveAsPreferences>(
        "get_save_as_preferences",
      );
      const result = await invoke<OverlaySaveResult>("overlay_save_capture", {
        path,
        presentationId,
        filename: suggestedCaptureFilename(new Date(), saveAsPreferences),
      });
      if (actionCoordinator.current?.isCurrent(action)) {
        setNotice(
          result.format === "jpeg"
            ? `Saved ${destinationName(result.destination)} as JPEG · transparency uses white`
            : `Saved ${destinationName(result.destination)} as PNG`,
        );
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

  async function startDragCapture() {
    if (!nativeRuntime || !capture?.path || !imageReady || imageFailed) return;
    const { path, presentationId } = capture;
    const action = actionCoordinator.current?.begin(path, "drag");
    if (!action) return;
    dragAction.current = { token: action, presentationId };
    setBusyAction("drag");
    setNotice("Drag into any app");
    setNoticeIsWarning(false);
    try {
      await invoke<OverlayDragStarted>("overlay_start_drag", {
        path,
        presentationId,
        filename: suggestedCaptureFilename(),
      });
    } catch (error) {
      if (actionCoordinator.current?.finish(action)) {
        dragAction.current = null;
        setBusyAction(null);
        setNotice(`Drag failed: ${String(error)}`);
        setNoticeIsWarning(true);
      }
    }
  }

  const handleImageFailure = useCallback((failed: PresentedCapture) => {
    if (actionCoordinator.current?.generation() !== failed.presentation) return;
    dragGesture.current.reset();
    setImageReady(false);
    setImageFailed(true);
    if (nativeRuntime && failed.path) {
      void invoke<boolean>("overlay_image_failed", {
        path: failed.path,
        presentationId: failed.presentationId,
      }).catch(() => undefined);
    }
  }, [nativeRuntime]);

  const settleSwipe = useCallback((presentation: number) => {
    if (actionCoordinator.current?.generation() !== presentation) return;
    if (swipeQuietTimer.current !== null) window.clearTimeout(swipeQuietTimer.current);
    if (swipeSettleTimer.current !== null) window.clearTimeout(swipeSettleTimer.current);
    swipeQuietTimer.current = null;
    swipeGesture.current.reset();
    setSwipeOffset(0);
    if (reducedMotion) {
      setSwipePhase("idle");
      return;
    }
    setSwipePhase("settling");
    swipeSettleTimer.current = window.setTimeout(() => {
      swipeSettleTimer.current = null;
      if (actionCoordinator.current?.generation() === presentation) setSwipePhase("idle");
    }, 160);
  }, [reducedMotion]);

  useEffect(() => {
    const element = overlayElement.current;
    if (!element || !capture || !isRevealed) return;
    const presentation = capture.presentation;

    const handleWheel = (rawEvent: WheelEvent) => {
      if (
        busyAction !== null ||
        temporarilyHidden ||
        imageFailed ||
        swipePhase === "exiting"
      ) {
        return;
      }
      const event = rawEvent as WebKitWheelEvent;
      const result = swipeGesture.current.move(
        {
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          deltaMode: event.deltaMode,
          directionInvertedFromDevice: Boolean(event.webkitDirectionInvertedFromDevice),
        },
        element.clientWidth,
      );

      if (result.kind === "ignored") {
        if (swipeGesture.current.offset() === 0) {
          if (swipeQuietTimer.current !== null) window.clearTimeout(swipeQuietTimer.current);
          swipeQuietTimer.current = window.setTimeout(() => {
            swipeQuietTimer.current = null;
            swipeGesture.current.reset();
          }, 100);
        }
        return;
      }

      rawEvent.preventDefault();
      if (swipeQuietTimer.current !== null) window.clearTimeout(swipeQuietTimer.current);
      swipeQuietTimer.current = null;
      if (swipeSettleTimer.current !== null) {
        window.clearTimeout(swipeSettleTimer.current);
        swipeSettleTimer.current = null;
      }

      if (result.kind === "tracking") {
        setSwipePhase("tracking");
        setSwipeOffset(result.offsetX);
        swipeQuietTimer.current = window.setTimeout(() => {
          swipeQuietTimer.current = null;
          settleSwipe(presentation);
        }, 100);
        return;
      }

      setSwipePhase("exiting");
      setSwipeOffset(element.clientWidth + 24);
      swipeExitTimer.current = window.setTimeout(() => {
        swipeExitTimer.current = null;
        if (actionCoordinator.current?.generation() !== presentation) return;
        void dismiss("close").then((dismissed) => {
          if (!dismissed) settleSwipe(presentation);
        });
      }, reducedMotion ? 0 : 140);
    };

    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  }, [
    busyAction,
    capture,
    dismiss,
    imageFailed,
    isRevealed,
    reducedMotion,
    settleSwipe,
    swipePhase,
    temporarilyHidden,
  ]);

  useEffect(() => {
    resetSwipePresentation();
  }, [capture?.presentation, resetSwipePresentation]);

  if (!capture) {
    return <main className="capture-overlay capture-overlay--waiting" aria-hidden="true" />;
  }

  const source = nativeRuntime && capture.path
    ? `${convertFileSrc(capture.path)}?presentation=${capture.presentationId}`
    : null;
  const isHistory = capture.source === "history";
  const swipeThreshold = Math.min(96, Math.max(1, window.innerWidth) * 0.25);
  const swipeOpacity = swipePhase === "tracking"
    ? Math.max(0.65, 1 - (swipeOffset / swipeThreshold) * 0.35)
    : 1;
  const overlayStyle = {
    "--capture-overlay-swipe-x": `${swipeOffset}px`,
    "--capture-overlay-swipe-opacity": String(swipeOpacity),
  } as CSSProperties;

  return (
    <main
      ref={overlayElement}
      key={capture.path ? `${capture.path}:${capture.presentationId}` : "preview"}
      className="capture-overlay"
      role="region"
      aria-label={isHistory
        ? "Restored Capso capture. Swipe right to dismiss."
        : "Latest Capso capture. Swipe right to dismiss."}
      data-revealed={isRevealed}
      data-swipe-phase={swipePhase}
      style={overlayStyle}
    >
      <div className="capture-overlay__preview" data-dragging={busyAction === "drag"}>
        {source && !imageFailed ? (
          <img
            key={`${capture.path}:${capture.presentationId}`}
            src={source}
            alt={isHistory ? "Restored screenshot" : "Latest screenshot"}
            title="Drag screenshot to another app"
            draggable={false}
            onPointerDown={(event) => {
              if (event.button !== 0 || !event.isPrimary || busyAction !== null) return;
              dragGesture.current.begin(event.pointerId, event.clientX, event.clientY);
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (!dragGesture.current.move(event.pointerId, event.clientX, event.clientY)) return;
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              void startDragCapture();
            }}
            onPointerUp={(event) => dragGesture.current.end(event.pointerId)}
            onPointerCancel={(event) => dragGesture.current.end(event.pointerId)}
            onLoad={(event) => {
              const image = event.currentTarget;
              const loadedCapture = capture;
              void (async () => {
                try {
                  await image.decode();
                } catch {
                  handleImageFailure(loadedCapture);
                  return;
                }
                if (
                  actionCoordinator.current?.generation() !== loadedCapture.presentation
                ) {
                  return;
                }
                setImageReady(true);
                void reveal();
              })();
            }}
            onError={() => handleImageFailure(capture)}
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

        <div className="capture-overlay__hover-actions" role="toolbar" aria-label="Capture actions">
          <button
            type="button"
            className="capture-overlay__action"
            aria-label="Copy capture"
            title="Copy to clipboard"
            data-busy={busyAction === "copy"}
            disabled={busyAction !== null || imageFailed}
            onClick={() => void copyCapture()}
          >
            <CopyIcon />
            <span>{busyAction === "copy" ? "Copying…" : "Copy"}</span>
          </button>
          <button
            type="button"
            className="capture-overlay__action"
            aria-label="Save capture as PNG or JPEG"
            title="Save to the folder set in Settings"
            data-busy={busyAction === "save"}
            disabled={busyAction !== null || imageFailed}
            onClick={() => void saveCapture()}
          >
            <SaveIcon />
            <span>{busyAction === "save" ? "Saving…" : "Save"}</span>
          </button>
        </div>

        <div
          className="capture-overlay__status"
          data-visible={Boolean(notice)}
          data-warning={noticeIsWarning}
          role="status"
          aria-live="polite"
        >
          {notice}
        </div>
      </div>
    </main>
  );
}
