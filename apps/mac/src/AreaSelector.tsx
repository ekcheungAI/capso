import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  AREA_ASPECT_RATIOS,
  applyExactPixelSize,
  detectVisualRect,
  magnifierPosition,
  nudgeSelection,
  selectionFromDrag,
  selectionPixelSize,
  shouldHandleSelectionKey,
  type AreaAspectRatio,
  type AreaPoint,
  type AreaSelection,
  type AreaViewport,
  type VisualAnalysis,
} from "./area-selector";

export type AreaSelectorSession = AreaViewport & {
  generation: number;
  previewPath?: string | null;
};

const MAGNIFIER_SIZE = 120;
const MAGNIFIER_ZOOM = 6;

const ratioLabel: Record<AreaAspectRatio, string> = {
  free: "Free",
  "1:1": "Square · 1:1",
  "4:3": "Standard · 4:3",
  "16:9": "Wide · 16:9",
};

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

function previewSession(): AreaSelectorSession {
  return {
    generation: 1,
    width: window.innerWidth,
    height: window.innerHeight,
    scaleFactor: 2,
    previewPath: null,
  };
}

function localPoint(event: ReactPointerEvent<HTMLElement>): AreaPoint {
  const bounds = event.currentTarget.getBoundingClientRect();
  return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
}

export default function AreaSelector() {
  const nativeRuntime = useMemo(isTauriRuntime, []);
  const [session, setSession] = useState<AreaSelectorSession | null>(() =>
    nativeRuntime ? null : previewSession(),
  );
  const [ratio, setRatio] = useState<AreaAspectRatio>("free");
  const [selection, setSelection] = useState<AreaSelection | null>(null);
  const [crosshair, setCrosshair] = useState<AreaPoint>({ x: 0, y: 0 });
  const [pointerSeen, setPointerSeen] = useState(false);
  const [previewReady, setPreviewReady] = useState(false);
  const [browserPreviewSource, setBrowserPreviewSource] = useState<string | null>(null);
  const [visualCandidate, setVisualCandidate] = useState<AreaSelection | null>(null);
  const [committing, setCommitting] = useState(false);
  const anchorRef = useRef<AreaPoint | null>(null);
  const snapCandidateRef = useRef<AreaSelection | null>(null);
  const analysisRef = useRef<VisualAnalysis | null>(null);
  const detectionFrameRef = useRef<number | null>(null);
  const detectionPointRef = useRef<AreaPoint | null>(null);
  const areaActionInFlight = useRef<string | null>(null);

  function beginAreaAction(key: string) {
    if (areaActionInFlight.current !== null) return false;
    areaActionInFlight.current = key;
    setCommitting(true);
    return true;
  }

  function endAreaAction(key: string) {
    if (areaActionInFlight.current !== key) return;
    areaActionInFlight.current = null;
    setCommitting(false);
  }

  useEffect(() => {
    if (!nativeRuntime) return;
    let disposed = false;
    let receivedAreaEvent = false;
    let unlisten: UnlistenFn | undefined;
    void (async () => {
      const stopListening = await listen<AreaSelectorSession>("area-selector-changed", ({ payload }) => {
        if (disposed) return;
        receivedAreaEvent = true;
        anchorRef.current = null;
        areaActionInFlight.current = null;
        setSelection(null);
        setRatio("free");
        setCommitting(false);
        setPointerSeen(false);
        setPreviewReady(false);
        setVisualCandidate(null);
        analysisRef.current = null;
        setSession(payload);
      });
      if (disposed) {
        stopListening();
        return;
      }
      unlisten = stopListening;
      const current = await invoke<AreaSelectorSession | null>("get_area_selector");
      if (!disposed && current && !receivedAreaEvent) setSession(current);
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [nativeRuntime]);

  useEffect(() => () => {
    if (detectionFrameRef.current !== null) cancelAnimationFrame(detectionFrameRef.current);
  }, []);

  useEffect(() => {
    if (nativeRuntime) return;
    const resize = () => setSession((current) => current && ({
      ...current,
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [nativeRuntime]);

  useEffect(() => {
    if (nativeRuntime || !session) {
      setBrowserPreviewSource(null);
      return;
    }
    setPreviewReady(false);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(16, Math.round(session.width));
    canvas.height = Math.max(12, Math.round(session.height));
    const context = canvas.getContext("2d");
    if (!context) return;
    const styles = getComputedStyle(document.documentElement);
    const token = (name: string) => styles.getPropertyValue(name).trim();
    context.fillStyle = token("--organise-surface");
    context.fillRect(0, 0, canvas.width, canvas.height);
    const target = {
      x: Math.round(canvas.width * 0.18),
      y: Math.round(canvas.height * 0.18),
      width: Math.round(canvas.width * 0.42),
      height: Math.round(canvas.height * 0.34),
    };
    context.fillStyle = token("--foreground");
    context.fillRect(target.x, target.y, target.width, target.height);
    context.fillStyle = token("--background");
    context.fillRect(
      target.x + Math.round(target.width * 0.08),
      target.y + Math.round(target.height * 0.16),
      Math.round(target.width * 0.42),
      Math.max(4, Math.round(target.height * 0.05)),
    );
    context.fillStyle = token("--intent-reference");
    context.fillRect(
      target.x + Math.round(target.width * 0.08),
      target.y + Math.round(target.height * 0.68),
      Math.round(target.width * 0.24),
      Math.round(target.height * 0.16),
    );
    setBrowserPreviewSource(canvas.toDataURL("image/png"));
  }, [nativeRuntime, session?.height, session?.width]);

  async function cancel() {
    if (!nativeRuntime || !session) return;
    const actionKey = `cancel:${session.generation}`;
    if (!beginAreaAction(actionKey)) return;
    try {
      await invoke("cancel_area_selection", { generation: session.generation });
    } finally {
      endAreaAction(actionKey);
    }
  }

  async function complete() {
    if (!nativeRuntime || !session || !selection || committing) return;
    const pixels = selectionPixelSize(selection, session.scaleFactor);
    if (pixels.width < 2 || pixels.height < 2) return;
    const actionKey = `complete:${session.generation}`;
    if (!beginAreaAction(actionKey)) return;
    try {
      const accepted = await invoke<boolean>("complete_area_selection", {
        generation: session.generation,
        selection,
      });
      if (!accepted) endAreaAction(actionKey);
    } catch {
      endAreaAction(actionKey);
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void cancel();
        return;
      }
      if (!shouldHandleSelectionKey((event.target as HTMLElement | null)?.tagName ?? "", event.key)) {
        return;
      }
      if (event.key === "Enter" && selection) {
        event.preventDefault();
        void complete();
        return;
      }
      const direction = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      }[event.key];
      if (!selection || !session || !direction) return;
      event.preventDefault();
      const multiplier = event.shiftKey ? 10 : 1;
      setSelection(nudgeSelection(
        selection,
        direction[0]! * multiplier,
        direction[1]! * multiplier,
        session,
      ));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [committing, nativeRuntime, selection, session]);

  if (!session) {
    return <main className="area-selector" aria-label="Preparing Area selection" />;
  }
  const activeSession = session;

  const pixels = selection ? selectionPixelSize(selection, activeSession.scaleFactor) : null;
  const visualPixels = visualCandidate
    ? selectionPixelSize(visualCandidate, activeSession.scaleFactor)
    : null;
  const magnifier = magnifierPosition(crosshair, activeSession, MAGNIFIER_SIZE);
  const previewSource = nativeRuntime
    ? activeSession.previewPath
      ? `${convertFileSrc(activeSession.previewPath)}?area=${activeSession.generation}`
      : null
    : browserPreviewSource;
  const previewKey = `${activeSession.generation}-${activeSession.width}x${activeSession.height}`;
  const showMagnifier = pointerSeen && previewReady;
  const controlTop = selection
    ? Math.min(activeSession.height - 76, Math.max(12, selection.y + selection.height + 12))
    : activeSession.height - 76;
  const controlLeft = selection
    ? Math.min(activeSession.width - 390, Math.max(12, selection.x))
    : Math.max(12, (activeSession.width - 390) / 2);

  function begin(event: ReactPointerEvent<HTMLElement>) {
    if (committing || (event.target as Element).closest(".area-selector__controls")) return;
    const point = localPoint(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    anchorRef.current = point;
    snapCandidateRef.current = ratio === "free" ? visualCandidate : null;
    setPointerSeen(true);
    setCrosshair(point);
    setSelection({ x: point.x, y: point.y, width: 0, height: 0 });
  }

  function scheduleVisualDetection(point: AreaPoint) {
    detectionPointRef.current = point;
    if (detectionFrameRef.current !== null) return;
    detectionFrameRef.current = requestAnimationFrame(() => {
      detectionFrameRef.current = null;
      const requested = detectionPointRef.current;
      setVisualCandidate(
        requested && analysisRef.current && ratio === "free" && !selection
          ? detectVisualRect(analysisRef.current, requested, activeSession)
          : null,
      );
    });
  }

  function move(event: ReactPointerEvent<HTMLElement>) {
    if ((event.target as Element).closest(".area-selector__controls")) {
      setPointerSeen(false);
      setVisualCandidate(null);
      return;
    }
    const point = localPoint(event);
    setPointerSeen(true);
    setCrosshair(point);
    if (!anchorRef.current) {
      scheduleVisualDetection(point);
      return;
    }
    const dragWidth = Math.abs(point.x - anchorRef.current.x);
    const dragHeight = Math.abs(point.y - anchorRef.current.y);
    if (dragWidth >= 4 || dragHeight >= 4) {
      snapCandidateRef.current = null;
      setVisualCandidate(null);
    }
    setSelection(selectionFromDrag(
      anchorRef.current,
      point,
      activeSession,
      event.shiftKey && ratio === "free" ? "1:1" : ratio,
    ));
  }

  function end(event: ReactPointerEvent<HTMLElement>) {
    if (!anchorRef.current) return;
    const point = localPoint(event);
    const snap = snapCandidateRef.current;
    const dragWidth = Math.abs(point.x - anchorRef.current.x);
    const dragHeight = Math.abs(point.y - anchorRef.current.y);
    const next = selectionFromDrag(
      anchorRef.current,
      point,
      activeSession,
      event.shiftKey && ratio === "free" ? "1:1" : ratio,
    );
    anchorRef.current = null;
    snapCandidateRef.current = null;
    if (snap && dragWidth < 4 && dragHeight < 4 && ratio === "free") {
      setVisualCandidate(null);
      setSelection(snap);
      return;
    }
    const size = selectionPixelSize(next, activeSession.scaleFactor);
    setSelection(size.width >= 2 && size.height >= 2 ? next : null);
  }

  function cancelPointer() {
    anchorRef.current = null;
    snapCandidateRef.current = null;
    setSelection(null);
    setVisualCandidate(null);
  }

  function loadPreview(image: HTMLImageElement) {
    setPreviewReady(true);
    try {
      const scale = Math.min(1, 960 / Math.max(activeSession.width, activeSession.height));
      const width = Math.max(16, Math.round(activeSession.width * scale));
      const height = Math.max(12, Math.round(activeSession.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Canvas pixels are unavailable");
      context.drawImage(image, 0, 0, width, height);
      analysisRef.current = { width, height, data: context.getImageData(0, 0, width, height).data };
    } catch {
      analysisRef.current = null;
      setVisualCandidate(null);
    }
  }

  function changeRatio(next: AreaAspectRatio) {
    setRatio(next);
    setVisualCandidate(null);
    if (selection && next !== "free") {
      setSelection(applyExactPixelSize(selection, "width", pixels!.width, activeSession, next));
    }
  }

  function changeSize(axis: "width" | "height", value: string) {
    if (!selection) return;
    setSelection(applyExactPixelSize(selection, axis, Number(value), activeSession, ratio));
  }

  return (
    <main
      className="area-selector"
      data-has-selection={selection !== null}
      aria-label="Select an Area to capture. Press Escape to cancel."
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={cancelPointer}
    >
      {!nativeRuntime && previewSource && (
        <img
          className="area-selector__preview-fixture"
          src={previewSource}
          alt=""
          draggable={false}
        />
      )}
      <div className="area-selector__crosshair area-selector__crosshair--x" style={{ top: crosshair.y }} />
      <div className="area-selector__crosshair area-selector__crosshair--y" style={{ left: crosshair.x }} />
      {previewSource && (
        <img
          key={previewKey}
          className="area-selector__preview-loader"
          src={previewSource}
          alt=""
          draggable={false}
          onLoad={(event) => loadPreview(event.currentTarget)}
          onError={() => {
            setPreviewReady(false);
            analysisRef.current = null;
            setVisualCandidate(null);
          }}
        />
      )}
      {showMagnifier && (
        <div
          className="area-selector__magnifier"
          aria-hidden="true"
          style={{ left: magnifier.x, top: magnifier.y }}
        >
          {previewSource ? (
            <img
              key={previewKey}
              src={previewSource}
              alt=""
              draggable={false}
              style={{
                width: activeSession.width * MAGNIFIER_ZOOM,
                height: activeSession.height * MAGNIFIER_ZOOM,
                left: MAGNIFIER_SIZE / 2 - crosshair.x * MAGNIFIER_ZOOM,
                top: MAGNIFIER_SIZE / 2 - crosshair.y * MAGNIFIER_ZOOM,
              }}
            />
          ) : (
            <div className="area-selector__magnifier-preview" />
          )}
          <i className="area-selector__magnifier-x" />
          <i className="area-selector__magnifier-y" />
        </div>
      )}
      {selection && (
        <div
          className="area-selector__selection"
          style={{
            left: selection.x,
            top: selection.y,
            width: selection.width,
            height: selection.height,
          }}
        >
          <span>{pixels!.width.toLocaleString()} × {pixels!.height.toLocaleString()} px</span>
        </div>
      )}
      {!selection && visualCandidate && (
        <div
          className="area-selector__visual-candidate"
          style={{
            left: visualCandidate.x,
            top: visualCandidate.y,
            width: visualCandidate.width,
            height: visualCandidate.height,
          }}
        >
          <span>Snap · {visualPixels!.width.toLocaleString()} × {visualPixels!.height.toLocaleString()} px</span>
        </div>
      )}
      <div
        className="area-selector__controls"
        style={{ left: controlLeft, top: controlTop }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <label>
          <span>W</span>
          <input
            type="number"
            min="2"
            max="32768"
            inputMode="numeric"
            aria-label="Selection width in pixels"
            value={pixels?.width ?? ""}
            disabled={!selection || committing}
            onChange={(event) => changeSize("width", event.target.value)}
          />
        </label>
        <span aria-hidden="true">×</span>
        <label>
          <span>H</span>
          <input
            type="number"
            min="2"
            max="32768"
            inputMode="numeric"
            aria-label="Selection height in pixels"
            value={pixels?.height ?? ""}
            disabled={!selection || committing}
            onChange={(event) => changeSize("height", event.target.value)}
          />
        </label>
        <label className="area-selector__ratio">
          <span>Ratio</span>
          <select
            aria-label="Aspect ratio"
            value={ratio}
            disabled={committing}
            onChange={(event) => changeRatio(event.target.value as AreaAspectRatio)}
          >
            {AREA_ASPECT_RATIOS.map((candidate) => (
              <option key={candidate} value={candidate}>{ratioLabel[candidate]}</option>
            ))}
          </select>
        </label>
        <button type="button" disabled={!selection || committing} onClick={() => void complete()}>
          Capture
        </button>
      </div>
      <p className="area-selector__hint">
        {selection
          ? "Enter captures · Arrow keys move 1 px · Shift moves 10 px · Esc cancels"
          : visualCandidate
            ? "Click to snap · Drag for a free area · Esc cancels"
            : "Drag to select · Hold Shift for square · Esc cancels"}
      </p>
    </main>
  );
}
