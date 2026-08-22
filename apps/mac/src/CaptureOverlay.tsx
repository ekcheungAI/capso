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
import { flushSync } from "react-dom";
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
import { reduceOverlayLifecycle } from "./overlay-lifecycle";
import {
  createOverlayAutoDismissTimer,
  isExactOverlayRendererIdentity,
  NativeOverlayAutoDismissBridge,
  PausableOverlayTimer,
  rendererOwnsAutoDismissPause,
  requestNativeOverlayRevealWithRetry,
  scheduleOverlayDomHiddenAcknowledgement,
  scheduleOverlayPaintAcknowledgement,
  shouldAcceptOverlaySurfaceGeneration,
  shouldRequestOverlayReveal,
} from "./overlay-timing";

type ClipboardStatus =
  | { status: "copied"; bytes: number }
  | { status: "unchanged" }
  | { status: "failed"; code: string; message: string };

type OverlayCapture = {
  path: string;
  presentationId: number;
  surfaceGeneration: number;
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
  surfaceGeneration: number;
  outcome: "dropped" | "cancelled";
};

type OverlayRestored = {
  path: string;
  presentationId: number;
  surfaceGeneration: number;
};

type OverlayDismissed = OverlayRestored & {
  reason: DismissReason;
};

type OverlaySurfaceState = {
  surfaceGeneration: number;
  phase: "hard_hidden" | "warm_hidden" | "visible";
  path?: string;
  presentationId?: number;
};

type OverlayRendererSnapshot = {
  surface: OverlaySurfaceState;
  capture: OverlayCapture | null;
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
  surfaceGeneration: 0,
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
  const [preparedPresentation, setPreparedPresentation] = useState<number | null>(null);
  const [revealedPresentation, setRevealedPresentation] = useState<number | null>(null);
  const [nativeShownPresentation, setNativeShownPresentation] = useState<number | null>(null);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [swipePhase, setSwipePhase] = useState<SwipePhase>("idle");
  const [pointerInteraction, setPointerInteraction] = useState(false);
  const [toolbarHovered, setToolbarHovered] = useState(false);
  const [revealRetryGeneration, setRevealRetryGeneration] = useState(0);
  const [warmedSurfaceGeneration, setWarmedSurfaceGeneration] = useState<number | null>(
    nativeRuntime ? null : PREVIEW_CAPTURE.surfaceGeneration,
  );
  const [reducedMotion, setReducedMotion] = useState(() =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  const overlayElement = useRef<HTMLElement | null>(null);
  const revealRequestedPresentation = useRef<number | null>(null);
  const paintRequestedPresentation = useRef<number | null>(null);
  const paintAcknowledgedPresentation = useRef<number | null>(null);
  const paintAcknowledgementCancel = useRef<(() => void) | null>(null);
  const domHiddenAcknowledgementCancel = useRef<(() => void) | null>(null);
  const componentMounted = useRef(true);
  const captureRef = useRef<PresentedCapture | null>(capture);
  const surfaceGenerationRef = useRef(nativeRuntime ? -1 : PREVIEW_CAPTURE.surfaceGeneration);
  const restoreEpoch = useRef(0);
  const dragGesture = useRef(new OverlayDragGesture(6));
  const swipeGesture = useRef(new OverlaySwipeGesture());
  const swipeQuietTimer = useRef<number | null>(null);
  const swipeSettleTimer = useRef<number | null>(null);
  const swipeExitTimer = useRef<number | null>(null);
  const dragAction = useRef<{
    token: OverlayActionToken;
    presentationId: number;
    surfaceGeneration: number;
  } | null>(null);
  const actionCoordinator = useRef<OverlayActionCoordinator | null>(null);
  if (actionCoordinator.current === null) {
    actionCoordinator.current = new OverlayActionCoordinator(
      nativeRuntime ? null : PREVIEW_CAPTURE.path,
    );
  }
  const dismissRef = useRef<(reason: DismissReason) => void>(() => undefined);
  const autoDismiss = useRef<PausableOverlayTimer | null>(null);
  const nativeAutoDismiss = useRef<NativeOverlayAutoDismissBridge | null>(null);
  if (nativeAutoDismiss.current === null) {
    nativeAutoDismiss.current = new NativeOverlayAutoDismissBridge(
      ({ path, presentationId, surfaceGeneration }, paused) =>
        invoke<boolean>("overlay_set_auto_dismiss_paused", {
          path,
          presentationId,
          surfaceGeneration,
          paused,
        }),
    );
  }

  const setRendererAutoDismissPaused = useCallback(
    (target: PresentedCapture, paused: boolean) => {
      if (!nativeRuntime || !target.path || target.autoDismissMs === null) {
        return Promise.resolve(false);
      }
      return nativeAutoDismiss.current!.setPaused(
        {
          path: target.path,
          presentationId: target.presentationId,
          surfaceGeneration: target.surfaceGeneration,
        },
        paused,
      );
    },
    [nativeRuntime],
  );

  const setToolbarAutoDismissPaused = useCallback(
    (paused: boolean) => {
      setToolbarHovered(paused);
      if (!capture) return;
      const shouldPause = rendererOwnsAutoDismissPause(
        pointerInteraction,
        swipePhase,
        busyAction,
        paused,
      );
      void setRendererAutoDismissPaused(capture, shouldPause);
    },
    [
      busyAction,
      capture,
      pointerInteraction,
      setRendererAutoDismissPaused,
      swipePhase,
    ],
  );

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
    captureRef.current = capture;
  }, [capture]);

  const scheduleDomHiddenAck = useCallback(
    (surfaceGeneration: number, conceal: () => void = () => undefined) => {
      if (
        !shouldAcceptOverlaySurfaceGeneration(
          surfaceGenerationRef.current,
          surfaceGeneration,
        )
      ) {
        return;
      }
      domHiddenAcknowledgementCancel.current?.();
      surfaceGenerationRef.current = surfaceGeneration;
      const identity = { surfaceGeneration };
      const isCurrent = () =>
        componentMounted.current && surfaceGenerationRef.current === surfaceGeneration;
      const cancel = scheduleOverlayDomHiddenAcknowledgement(
        identity,
        isCurrent,
        () => {
          flushSync(() => {
            setWarmedSurfaceGeneration(null);
            setRevealedPresentation(null);
            setNativeShownPresentation(null);
            conceal();
          });
        },
        ({ surfaceGeneration: generation }) =>
          invoke<boolean>("overlay_dom_hidden_painted", {
            surfaceGeneration: generation,
          }),
        ({ surfaceGeneration: generation }) => {
          if (!isCurrent()) return;
          setWarmedSurfaceGeneration(generation);
          setRevealRetryGeneration((current) => current + 1);
        },
        {
          request: (callback) => window.requestAnimationFrame(callback),
          cancel: (handle) => window.cancelAnimationFrame(handle),
        },
        {
          maxAttempts: 3,
          wait: () => new Promise<void>((resolve) => window.setTimeout(resolve, 80)),
          onFailed: () => {
            if (!isCurrent()) return;
            const failed = captureRef.current;
            console.error(
              `Could not warm Quick Access surface generation ${surfaceGeneration}.`,
            );
            if (!failed || failed.surfaceGeneration !== surfaceGeneration) return;
            void invoke<boolean>("overlay_dismiss", {
              path: failed.path,
              presentationId: failed.presentationId,
              surfaceGeneration: failed.surfaceGeneration,
              reason: "close",
            })
              .then((dismissed) => {
                if (!dismissed || !isCurrent()) return;
                actionCoordinator.current?.deactivateCapture(failed.path);
                captureRef.current = null;
                setCapture(null);
              })
              .catch((error) => {
                console.error("Could not clean up an unwarmed Quick Access surface", error);
              });
          },
        },
      );
      domHiddenAcknowledgementCancel.current = cancel;
    },
    [],
  );

  useEffect(() => {
    if (!nativeRuntime) return;

    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    let unlistenDrag: UnlistenFn | undefined;
    let unlistenHidden: UnlistenFn | undefined;
    let unlistenRestore: UnlistenFn | undefined;
    let unlistenDismissed: UnlistenFn | undefined;
    let snapshotInFlight = false;
    let snapshotRequested = false;

    const resetPaintRequests = () => {
      paintAcknowledgementCancel.current?.();
      paintAcknowledgementCancel.current = null;
      revealRequestedPresentation.current = null;
      paintRequestedPresentation.current = null;
      paintAcknowledgedPresentation.current = null;
    };

    const lifecycleState = () => {
      const current = captureRef.current;
      return {
        surfaceGeneration: surfaceGenerationRef.current,
        capture: current
          ? {
              path: current.path,
              presentationId: current.presentationId,
              surfaceGeneration: current.surfaceGeneration,
              temporarilyHidden: current.temporarilyHidden,
            }
          : null,
      };
    };

    const clearRendererCapture = () => {
      const current = captureRef.current;
      if (current) actionCoordinator.current?.deactivateCapture(current.path);
      resetPaintRequests();
      resetSwipePresentation();
      dragGesture.current.reset();
      dragAction.current = null;
      captureRef.current = null;
      setCapture(null);
      setPreparedPresentation(null);
      setImageReady(false);
      setImageFailed(false);
      setTemporarilyHidden(false);
      setBusyAction(null);
      setPointerInteraction(false);
      setToolbarHovered(false);
      setNotice(null);
      setNoticeIsWarning(false);
    };

    const applyRendererSnapshot = (snapshot: OverlayRendererSnapshot) => {
      const { surface, capture: current } = snapshot;
      const lifecycle = reduceOverlayLifecycle(lifecycleState(), {
        kind: "bootstrap",
        surfaceGeneration: surface.surfaceGeneration,
        capture: current,
      });
      if (disposed || lifecycle.decision !== "apply") return;

      if (current) {
        resetSwipePresentation();
        resetPaintRequests();
        const presentation = actionCoordinator.current!.activateCapture(current.path);
        const next = {
          ...current,
          presentation,
          surfaceGeneration: lifecycle.state.surfaceGeneration,
        };
        scheduleDomHiddenAck(lifecycle.state.surfaceGeneration, () => {
          captureRef.current = next;
          setCapture(next);
          setPreparedPresentation(null);
          setRevealedPresentation(null);
          setImageFailed(false);
          setImageReady(false);
          setTemporarilyHidden(next.temporarilyHidden);
          setBusyAction(null);
        });
        return;
      }

      scheduleDomHiddenAck(
        lifecycle.state.surfaceGeneration,
        clearRendererCapture,
      );
    };

    const requestRendererSnapshot = (resync = false) => {
      if (resync || !snapshotInFlight) snapshotRequested = true;
      if (snapshotInFlight) return;
      snapshotInFlight = true;
      void (async () => {
        while (!disposed && snapshotRequested) {
          snapshotRequested = false;
          try {
            const snapshot = await invoke<OverlayRendererSnapshot>(
              "overlay_renderer_ready",
            );
            applyRendererSnapshot(snapshot);
          } catch (error) {
            console.error("Could not synchronize the Quick Access renderer", error);
          }
        }
      })().finally(() => {
        snapshotInFlight = false;
        if (!disposed && snapshotRequested) requestRendererSnapshot();
      });
    };

    const resyncRenderer = (surfaceGeneration: number) => {
      scheduleDomHiddenAck(surfaceGeneration, clearRendererCapture);
      requestRendererSnapshot(true);
    };

    void (async () => {
      unlisten = await listen<OverlayCapture>("overlay-capture", (event) => {
        if (disposed) return;
        const lifecycle = reduceOverlayLifecycle(lifecycleState(), {
          kind: "capture",
          capture: event.payload,
        });
        if (lifecycle.decision !== "apply") return;
        resetSwipePresentation();
        dragGesture.current.reset();
        dragAction.current = null;
        setPointerInteraction(false);
        setToolbarHovered(false);
        const presentation = actionCoordinator.current!.activateCapture(event.payload.path);
        const next = { ...event.payload, presentation };
        resetPaintRequests();
        scheduleDomHiddenAck(event.payload.surfaceGeneration, () => {
          captureRef.current = next;
          setCapture(next);
          setPreparedPresentation(null);
          setImageFailed(false);
          setImageReady(false);
          setTemporarilyHidden(event.payload.temporarilyHidden);
          setBusyAction(null);
          setNotice(null);
          setNoticeIsWarning(false);
        });
      });
      unlistenDrag = await listen<OverlayDragEnded>("overlay-drag-ended", (event) => {
        if (disposed) return;
        const active = dragAction.current;
        if (
          !active ||
          active.token.path !== event.payload.path ||
          active.presentationId !== event.payload.presentationId ||
          active.surfaceGeneration !== event.payload.surfaceGeneration ||
          captureRef.current?.surfaceGeneration !== event.payload.surfaceGeneration ||
          !actionCoordinator.current?.finish(active.token)
        ) {
          return;
        }
        dragAction.current = null;
        setPointerInteraction(false);
        setBusyAction(null);
        setNoticeIsWarning(false);
        setNotice(event.payload.outcome === "dropped" ? "Shared a copy" : null);
      });
      unlistenHidden = await listen<OverlayRestored>("overlay-hidden", (event) => {
        if (disposed) return;
        const lifecycle = reduceOverlayLifecycle(lifecycleState(), {
          kind: "hidden",
          ...event.payload,
        });
        if (lifecycle.decision === "ignore") return;
        if (lifecycle.decision === "resync") {
          resyncRenderer(lifecycle.state.surfaceGeneration);
          return;
        }
        const current = captureRef.current!;
        const presentation = actionCoordinator.current!.activateCapture(current.path);
        const next = {
          ...current,
          presentation,
          surfaceGeneration: event.payload.surfaceGeneration,
          temporarilyHidden: true,
        };
        resetPaintRequests();
        autoDismiss.current?.pause();
        dragGesture.current.reset();
        dragAction.current = null;
        scheduleDomHiddenAck(event.payload.surfaceGeneration, () => {
          captureRef.current = next;
          setCapture(next);
          setPreparedPresentation(null);
          setImageReady(false);
          setImageFailed(false);
          setTemporarilyHidden(true);
          setPointerInteraction(false);
          setToolbarHovered(false);
          setBusyAction(null);
        });
      });
      unlistenRestore = await listen<OverlayRestored>("overlay-restored", (event) => {
        if (disposed) return;
        const lifecycle = reduceOverlayLifecycle(lifecycleState(), {
          kind: "restored",
          ...event.payload,
        });
        if (lifecycle.decision === "ignore") return;
        if (lifecycle.decision === "resync") {
          resyncRenderer(lifecycle.state.surfaceGeneration);
          return;
        }
        const current = captureRef.current!;
        if (autoDismiss.current?.remainingMs() === 0) autoDismiss.current.reset();
        restoreEpoch.current += 1;
        const presentation = actionCoordinator.current!.activateCapture(current.path);
        const next = {
          ...current,
          presentation,
          surfaceGeneration: event.payload.surfaceGeneration,
          temporarilyHidden: false,
        };
        resetPaintRequests();
        scheduleDomHiddenAck(event.payload.surfaceGeneration, () => {
          captureRef.current = next;
          setCapture(next);
          setPreparedPresentation(null);
          setImageReady(false);
          setImageFailed(false);
          setTemporarilyHidden(false);
          setNotice("Quick Access restored");
          setNoticeIsWarning(false);
        });
      });
      unlistenDismissed = await listen<OverlayDismissed>(
        "capture-overlay-dismissed",
        (event) => {
          if (disposed) return;
          const lifecycle = reduceOverlayLifecycle(lifecycleState(), {
            kind: "dismissed",
            ...event.payload,
          });
          if (lifecycle.decision !== "apply") return;
          scheduleDomHiddenAck(
            lifecycle.state.surfaceGeneration,
            clearRendererCapture,
          );
        },
      );

      if (disposed) {
        unlisten?.();
        unlistenDrag?.();
        unlistenHidden?.();
        unlistenRestore?.();
        unlistenDismissed?.();
        return;
      }

      requestRendererSnapshot();
    })();

    return () => {
      disposed = true;
      unlisten?.();
      unlistenDrag?.();
      unlistenHidden?.();
      unlistenRestore?.();
      unlistenDismissed?.();
    };
  }, [nativeRuntime, resetSwipePresentation, scheduleDomHiddenAck]);

  const commitPrepared = useCallback(() => {
    if (!capture) return;
    const presentation = capture.presentation;
    if (actionCoordinator.current?.generation() !== presentation) return;
    if (warmedSurfaceGeneration !== capture.surfaceGeneration || temporarilyHidden) return;
    setPreparedPresentation(presentation);
  }, [capture, temporarilyHidden, warmedSurfaceGeneration]);

  const requestNativeShow = useCallback(async () => {
    if (!nativeRuntime || !capture?.path) return;
    const { path, presentation, presentationId, surfaceGeneration } = capture;
    if (revealRequestedPresentation.current === presentation) return;
    const revealAction = actionCoordinator.current?.begin(path, "reveal");
    if (!revealAction) return;
    const restoreEpochAtStart = restoreEpoch.current;
    revealRequestedPresentation.current = presentation;
    const isCurrent = () =>
      componentMounted.current &&
      actionCoordinator.current?.isCurrent(revealAction) === true &&
      surfaceGenerationRef.current === surfaceGeneration;
    const revealResult = await requestNativeOverlayRevealWithRetry(
      () =>
        invoke<boolean>("overlay_image_ready", {
          path,
          presentationId,
          surfaceGeneration,
        }),
      isCurrent,
      () => new Promise<void>((resolve) => window.setTimeout(resolve, 80)),
      3,
    );
    if (!isCurrent()) return;
    if (revealResult === "shown") {
      if (actionCoordinator.current?.finish(revealAction)) {
        setNativeShownPresentation(presentation);
      }
      return;
    }
    if (revealResult === "not_shown") {
      if (actionCoordinator.current?.finish(revealAction)) {
        revealRequestedPresentation.current = null;
        if (restoreEpoch.current !== restoreEpochAtStart) {
          setRevealRetryGeneration((generation) => generation + 1);
        }
      }
      return;
    }
    if (revealResult === "failed") {
      let dismissed = false;
      try {
        dismissed = await invoke<boolean>("overlay_dismiss", {
          path,
          presentationId,
          surfaceGeneration,
          reason: "close",
        });
      } catch (error) {
        console.error("Could not clean up a failed native overlay reveal", error);
      }
      if (!isCurrent()) return;
      if (!dismissed) {
        if (actionCoordinator.current?.finish(revealAction)) {
          revealRequestedPresentation.current = null;
          setNotice("Quick Access could not reveal this preview yet");
          setNoticeIsWarning(true);
        }
        return;
      }
      if (actionCoordinator.current?.dismiss(revealAction)) {
        revealRequestedPresentation.current = null;
        paintRequestedPresentation.current = null;
        paintAcknowledgedPresentation.current = null;
        setPreparedPresentation(null);
        setRevealedPresentation(null);
        setNativeShownPresentation(null);
        if (captureRef.current?.presentation === presentation) {
          captureRef.current = null;
        }
        setCapture((current) =>
          current?.presentation === presentation ? null : current,
        );
      }
    }
  }, [capture, nativeRuntime]);

  const isSurfaceWarm =
    capture !== null && warmedSurfaceGeneration === capture.surfaceGeneration;

  useEffect(() => {
    if (
      !capture ||
      !shouldRequestOverlayReveal(
        imageReady,
        imageFailed,
        temporarilyHidden,
        isSurfaceWarm,
        preparedPresentation === capture.presentation,
      )
    ) {
      return;
    }
    commitPrepared();
  }, [
    capture,
    commitPrepared,
    imageFailed,
    imageReady,
    isSurfaceWarm,
    preparedPresentation,
    temporarilyHidden,
  ]);

  const isPrepared =
    capture !== null &&
    imageReady &&
    !imageFailed &&
    preparedPresentation === capture.presentation;

  const isRevealed =
    isPrepared &&
    isSurfaceWarm &&
    !temporarilyHidden &&
    capture !== null &&
    revealedPresentation === capture.presentation;

  useEffect(() => {
    if (
      nativeRuntime ||
      !capture ||
      !isPrepared ||
      temporarilyHidden ||
      revealedPresentation === capture.presentation
    ) {
      return;
    }
    const presentation = capture.presentation;
    const frame = window.requestAnimationFrame(() => {
      if (actionCoordinator.current?.generation() === presentation) {
        setRevealedPresentation(presentation);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [capture, isPrepared, nativeRuntime, revealedPresentation, temporarilyHidden]);

  useEffect(() => {
    if (
      !nativeRuntime ||
      !capture?.path ||
      !isPrepared ||
      temporarilyHidden ||
      nativeShownPresentation === capture.presentation
    ) {
      return;
    }
    void requestNativeShow();
  }, [
    capture,
    isPrepared,
    nativeRuntime,
    nativeShownPresentation,
    requestNativeShow,
    revealRetryGeneration,
    temporarilyHidden,
  ]);

  useEffect(() => {
    if (
      !nativeRuntime ||
      !capture?.path ||
      !isPrepared ||
      temporarilyHidden ||
      nativeShownPresentation !== capture.presentation ||
      paintRequestedPresentation.current === capture.presentation ||
      paintAcknowledgedPresentation.current === capture.presentation
    ) {
      return;
    }

    const { path, presentationId, presentation, surfaceGeneration } = capture;
    paintRequestedPresentation.current = presentation;
    const cancel = scheduleOverlayPaintAcknowledgement(
      { path, presentationId, presentation, surfaceGeneration, reducedMotion },
      () =>
        actionCoordinator.current?.generation() === presentation &&
        surfaceGenerationRef.current === surfaceGeneration,
      () => {
        if (actionCoordinator.current?.generation() !== presentation) return;
        flushSync(() => setRevealedPresentation(presentation));
      },
      ({ path, presentationId, surfaceGeneration, reducedMotion }) =>
        invoke<boolean>("overlay_presentation_painted", {
          path,
          presentationId,
          surfaceGeneration,
          reducedMotion,
        }),
      (painted) => {
        if (actionCoordinator.current?.generation() === painted.presentation) {
          paintAcknowledgedPresentation.current = painted.presentation;
        }
      },
      {
        request: (callback) => window.requestAnimationFrame(callback),
        cancel: (handle) => window.cancelAnimationFrame(handle),
      },
      {
        maxAttempts: 3,
        wait: () => new Promise<void>((resolve) => window.setTimeout(resolve, 80)),
        onFailed: (failed) => {
          if (
            !componentMounted.current ||
            actionCoordinator.current?.generation() !== failed.presentation
          ) {
            return;
          }
          const action = actionCoordinator.current.begin(failed.path, "dismiss");
          if (!action) return;
          void invoke<boolean>("overlay_dismiss", {
            path: failed.path,
            presentationId: failed.presentationId,
            surfaceGeneration: failed.surfaceGeneration,
            reason: "close",
          })
            .then((dismissed) => {
              if (
                !dismissed ||
                !componentMounted.current ||
                !actionCoordinator.current?.dismiss(action)
              ) {
                if (componentMounted.current) {
                  actionCoordinator.current?.finish(action);
                }
                return;
              }
              revealRequestedPresentation.current = null;
              paintRequestedPresentation.current = null;
              paintAcknowledgedPresentation.current = null;
              setPreparedPresentation(null);
              setRevealedPresentation(null);
              setNativeShownPresentation(null);
              if (captureRef.current?.presentation === failed.presentation) {
                captureRef.current = null;
              }
              setCapture((current) =>
                current?.presentation === failed.presentation ? null : current,
              );
            })
            .catch((error) => {
              console.error("Could not clean up a failed overlay paint", error);
              if (componentMounted.current) {
                actionCoordinator.current?.finish(action);
              }
            });
        },
      },
    );
    paintAcknowledgementCancel.current = cancel;

    return () => {
      cancel();
      if (paintAcknowledgementCancel.current === cancel) {
        paintAcknowledgementCancel.current = null;
      }
      if (
        paintAcknowledgedPresentation.current !== presentation &&
        paintRequestedPresentation.current === presentation
      ) {
        paintRequestedPresentation.current = null;
      }
    };
  }, [
    capture,
    isPrepared,
    nativeRuntime,
    nativeShownPresentation,
    reducedMotion,
    temporarilyHidden,
  ]);

  const dismiss = useCallback(
    async (reason: DismissReason): Promise<boolean> => {
      if (!capture) return false;
      if (!nativeRuntime || !capture.path) {
        captureRef.current = null;
        setCapture(null);
        return true;
      }

      const { path, presentationId, surfaceGeneration } = capture;
      const action = actionCoordinator.current?.begin(path, "dismiss");
      if (!action) return false;
      setBusyAction("dismiss");
      try {
        const dismissed = await invoke<boolean>("overlay_dismiss", {
          path,
          presentationId,
          surfaceGeneration,
          reason,
        });
        if (dismissed && actionCoordinator.current?.dismiss(action)) {
          setBusyAction(null);
          captureRef.current = null;
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
    const timerPresentation = capture?.presentation ?? null;
    autoDismiss.current = createOverlayAutoDismissTimer(
      capture?.autoDismissMs ?? null,
      () => {
        if (
          timerPresentation === null ||
          actionCoordinator.current?.generation() !== timerPresentation
        ) {
          return;
        }
        dismissRef.current("timeout");
      },
      {
        now: () => performance.now(),
        set: (callback, delayMs) => window.setTimeout(callback, delayMs),
        clear: (handle) => window.clearTimeout(handle),
      },
    );
  }, [capture?.autoDismissMs, capture?.presentation]);

  const shouldRunAutoDismiss =
    !nativeRuntime &&
    Boolean(capture?.path) &&
    capture?.autoDismissMs !== null &&
    imageReady &&
    !imageFailed &&
    isRevealed &&
    !temporarilyHidden &&
    busyAction === null &&
    !pointerInteraction &&
    swipePhase === "idle";

  useEffect(() => {
    if (shouldRunAutoDismiss) autoDismiss.current?.start();
    else autoDismiss.current?.pause();
  }, [
    busyAction,
    capture?.autoDismissMs,
    capture?.path,
    imageFailed,
    imageReady,
    isRevealed,
    nativeRuntime,
    pointerInteraction,
    swipePhase,
    temporarilyHidden,
  ]);

  const rendererInteractionActive = rendererOwnsAutoDismissPause(
    pointerInteraction,
    swipePhase,
    busyAction,
    toolbarHovered,
  );

  useEffect(() => {
    if (!nativeRuntime || !capture?.path || capture.autoDismissMs === null) return;
    void setRendererAutoDismissPaused(capture, rendererInteractionActive);
  }, [
    capture?.autoDismissMs,
    capture?.path,
    capture?.presentationId,
    capture?.surfaceGeneration,
    nativeRuntime,
    rendererInteractionActive,
    setRendererAutoDismissPaused,
  ]);

  useEffect(() => {
    if (!nativeRuntime || !capture?.path || capture.autoDismissMs === null) return;
    const activeCapture = capture;
    return () => {
      void setRendererAutoDismissPaused(activeCapture, false);
    };
  }, [
    capture?.autoDismissMs,
    capture?.path,
    capture?.presentationId,
    capture?.surfaceGeneration,
    nativeRuntime,
    setRendererAutoDismissPaused,
  ]);

  useEffect(() => {
    componentMounted.current = true;
    return () => {
      componentMounted.current = false;
      autoDismiss.current?.cancel();
      paintAcknowledgementCancel.current?.();
      domHiddenAcknowledgementCancel.current?.();
      clearSwipeTimers();
    };
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
      await setRendererAutoDismissPaused(capture, true);
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
      await setRendererAutoDismissPaused(capture, true);
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
    const { path, presentationId, surfaceGeneration } = capture;
    const action = actionCoordinator.current?.begin(path, "drag");
    if (!action) return;
    dragAction.current = { token: action, presentationId, surfaceGeneration };
    setBusyAction("drag");
    setNotice("Drag into any app");
    setNoticeIsWarning(false);
    try {
      await setRendererAutoDismissPaused(capture, true);
      await invoke<OverlayDragStarted>("overlay_start_drag", {
        path,
        presentationId,
        surfaceGeneration,
        filename: suggestedCaptureFilename(),
      });
      setPointerInteraction(false);
    } catch (error) {
      if (actionCoordinator.current?.finish(action)) {
        dragAction.current = null;
        setBusyAction(null);
        setPointerInteraction(false);
        setNotice(`Drag failed: ${String(error)}`);
        setNoticeIsWarning(true);
      }
    }
  }

  const handleImageFailure = useCallback((failed: PresentedCapture) => {
    const isCurrent = () =>
      actionCoordinator.current?.generation() === failed.presentation &&
      surfaceGenerationRef.current === failed.surfaceGeneration;
    if (!isCurrent()) return;
    const commitFailure = () => {
      if (!isCurrent()) return;
      paintAcknowledgementCancel.current?.();
      paintAcknowledgementCancel.current = null;
      paintRequestedPresentation.current = null;
      paintAcknowledgedPresentation.current = null;
      dragGesture.current.reset();
      setPreparedPresentation(null);
      setRevealedPresentation(null);
      setNativeShownPresentation(null);
      setImageReady(false);
      setImageFailed(true);
    };
    if (nativeRuntime && failed.path) {
      void invoke<boolean>("overlay_image_failed", {
        path: failed.path,
        presentationId: failed.presentationId,
        surfaceGeneration: failed.surfaceGeneration,
      })
        .then((accepted) => {
          if (!accepted) return;
          commitFailure();
        })
        .catch((error) => {
          console.error("Could not report a failed Quick Access image", error);
        });
      return;
    }
    commitFailure();
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
        void setRendererAutoDismissPaused(capture, true);
        setSwipePhase("tracking");
        setSwipeOffset(result.offsetX);
        swipeQuietTimer.current = window.setTimeout(() => {
          swipeQuietTimer.current = null;
          settleSwipe(presentation);
        }, 100);
        return;
      }

      void setRendererAutoDismissPaused(capture, true);
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
    setRendererAutoDismissPaused,
    swipePhase,
    temporarilyHidden,
  ]);

  useEffect(() => {
    resetSwipePresentation();
  }, [capture?.presentation, resetSwipePresentation]);

  if (!capture) {
    return (
      <main
        className="capture-overlay capture-overlay--waiting"
        aria-hidden="true"
        inert
      />
    );
  }

  const source = nativeRuntime && capture.path
    ? `${convertFileSrc(capture.path)}?presentation=${capture.presentationId}&surface=${capture.surfaceGeneration}`
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
      key={capture.path
        ? `${capture.path}:${capture.presentationId}:${capture.surfaceGeneration}`
        : "preview"}
      className="capture-overlay"
      role="region"
      aria-hidden={!isRevealed}
      inert={!isRevealed}
      aria-label={isHistory
        ? "Restored Capso capture. Swipe right to dismiss."
        : "Latest Capso capture. Swipe right to dismiss."}
      data-native-runtime={nativeRuntime}
      data-prepared={isPrepared}
      data-revealed={isRevealed}
      data-swipe-phase={swipePhase}
      style={overlayStyle}
    >
      <div className="capture-overlay__preview" data-dragging={busyAction === "drag"}>
        {source && !imageFailed ? (
          <img
            key={`${capture.path}:${capture.presentationId}:${capture.surfaceGeneration}`}
            src={source}
            alt={isHistory ? "Restored screenshot" : "Latest screenshot"}
            title="Drag screenshot to another app"
            draggable={false}
            onPointerDown={(event) => {
              if (
                event.button !== 0 ||
                !event.isPrimary ||
                busyAction !== null ||
                swipePhase !== "idle"
              ) {
                return;
              }
              setPointerInteraction(true);
              void setRendererAutoDismissPaused(capture, true);
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
            onPointerUp={(event) => {
              dragGesture.current.end(event.pointerId);
              setPointerInteraction(false);
            }}
            onPointerCancel={(event) => {
              dragGesture.current.end(event.pointerId);
              setPointerInteraction(false);
            }}
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
                if (!isExactOverlayRendererIdentity(
                  {
                    presentation: actionCoordinator.current?.generation() ?? -1,
                    surfaceGeneration: surfaceGenerationRef.current,
                  },
                  loadedCapture,
                )) {
                  return;
                }
                setImageReady(true);
                commitPrepared();
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

        <div
          className="capture-overlay__hover-actions"
          role="toolbar"
          aria-label="Capture actions"
          onPointerEnter={() => setToolbarAutoDismissPaused(true)}
          onPointerLeave={() => setToolbarAutoDismissPaused(false)}
        >
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
