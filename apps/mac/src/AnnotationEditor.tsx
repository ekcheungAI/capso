import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { save as chooseSaveDestination } from "@tauri-apps/plugin-dialog";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { CapsoGlyph, CapsoGlyphDefs } from "./glyphs.generated";
import {
  appendFreehandPoint,
  axisLockedDelta,
  DEFAULT_IMAGE_SCALE,
  DEFAULT_ARROW_STYLE,
  DEFAULT_BLUR_MODE,
  DEFAULT_BLUR_STRENGTH,
  DEFAULT_COLOR,
  DEFAULT_COUNTER_STYLE,
  DEFAULT_HIGHLIGHTER_OPACITY,
  DEFAULT_IMAGE_TRANSFORM,
  DEFAULT_SIZE_PRESET,
  DEFAULT_SPOTLIGHT_STRENGTH,
  DEFAULT_SPOTLIGHT_SHAPE,
  DEFAULT_STROKE_WEIGHT,
  DEFAULT_TEXT_STYLE,
  counterSizeFor,
  closestSizePreset,
  cropFromDrag,
  cropFromDragWithAspect,
  detectSmartHighlightBand,
  eraseFreehandMarks,
  eraserRadiusFor,
  fitTextWithinCanvas,
  hitTest,
  hitResizeHandle,
  imageDeltaFromOutput,
  imageScaleForOutputDimension,
  imageScaleOutputSize,
  imagePointFromOutput,
  imagePointToOutput,
  imageTransformMatrix,
  imageTransformOutputSize,
  isDegenerate,
  isDegenerateCrop,
  isDefaultImageTransform,
  isValidImageScale,
  nextCounterValue,
  PALETTE,
  paintAll,
  paintSelection,
  rectFrom,
  rectFromSquareDrag,
  redacts,
  resizeHandles,
  resizeMark,
  sizeForPreset,
  textSizeFor,
  translate,
  updateImageTransform,
  type ArrowStyle,
  type AnnotationCrop,
  type AnnotationPoint,
  type BlurMode,
  type BlurStrength,
  type CropAspect,
  type CounterStyle,
  type ImageTransform,
  type ImageTransformAction,
  type HighlighterOpacity,
  type Mark,
  type ResizeHandle,
  type SizePreset,
  type SpotlightStrength,
  type SpotlightShape,
  type StrokeWeight,
  type TextStyle,
  type Tool,
} from "@capso/shared/annotate";
import {
  annotationEditReducer,
  copySelectedMark,
  duplicateSelectedMark,
  EMPTY_ANNOTATION_EDIT_STATE,
  pasteCopiedMark,
  selectionAfterApply,
  selectionAfterReverse,
} from "./annotation-history";
import {
  isAnnotationHexColor,
  readAnnotationCustomColors,
  saveAnnotationCustomColor,
} from "./annotation-colors";
import {
  CANVAS_ZOOM_STEPS,
  canvasZoomStep,
  fitCanvasSize,
  zoomedCanvasSize,
  type CanvasZoomDirection,
} from "./annotation-zoom";
import {
  OverlayDragGesture,
  saveAsFilters,
  suggestedCaptureFilename,
  type OverlaySaveAsPreferences,
} from "./overlay-drag";

type AnnotationCapture = {
  id: string;
  path: string;
  sourcePath: string;
  presentationId: number;
  sessionId: number;
  documentRevision: number;
  crop: AnnotationCrop | null;
  imageTransform: ImageTransform;
  imageScale: number;
  marks: Mark[];
  editingExisting: boolean;
};

type AnnotationSaveResult = {
  bytes: number;
  originalPath: string;
  toolsUsed: (Tool | "transform" | "resize")[];
  redacted: boolean;
  documentRevision: number;
};

type AnnotationDragStarted = { bytes: number };
type AnnotationCopyResult = { bytes: number };
type AnnotationExportResult = {
  destination: string;
  bytes: number;
  format: "png" | "jpeg";
};
type AnnotationDragEnded = {
  sessionId: number;
  outcome: "dropped" | "cancelled";
};

const PREVIEW_MODE = new URLSearchParams(window.location.search).get("preview");
const PREVIEW_EDITABLE_PROJECT = PREVIEW_MODE === "project" || PREVIEW_MODE === "crop";
const PREVIEW_PROJECT_MARKS: Mark[] = [
  {
    kind: "arrow",
    color: DEFAULT_COLOR,
    x1: 390,
    y1: 560,
    x2: 690,
    y2: 430,
    arrowStyle: "curved",
    strokeWeight: "bold",
  },
  {
    kind: "text",
    color: PALETTE[3],
    x: 390,
    y: 360,
    text: "Editable project",
    size: 32,
    textStyle: "rounded-boxed",
  },
];

const PREVIEW_CAPTURE: AnnotationCapture = {
  id: "preview-capture",
  path: "",
  sourcePath: "",
  presentationId: 0,
  sessionId: 0,
  documentRevision: PREVIEW_EDITABLE_PROJECT ? 3 : 0,
  crop: PREVIEW_MODE === "crop" ? { x: 180, y: 100, w: 900, h: 560 } : null,
  imageTransform: DEFAULT_IMAGE_TRANSFORM,
  imageScale: DEFAULT_IMAGE_SCALE,
  marks: PREVIEW_EDITABLE_PROJECT ? PREVIEW_PROJECT_MARKS : [],
  editingExisting: PREVIEW_EDITABLE_PROJECT,
};

const COLOR_NAMES = ["Red", "Amber", "Green", "Blue", "Purple"] as const;
const ARROW_STYLES: ArrowStyle[] = ["classic", "open", "curved", "double"];
const TEXT_STYLES: TextStyle[] = [
  "standard", "rounded", "monospaced", "outlined", "boxed", "rounded-boxed", "monospaced-boxed",
];
const STROKE_WEIGHTS: StrokeWeight[] = ["thin", "regular", "bold"];
const HIGHLIGHTER_OPACITIES: HighlighterOpacity[] = ["soft", "regular", "strong"];
const SPOTLIGHT_STRENGTHS: SpotlightStrength[] = ["soft", "regular", "strong"];
const SPOTLIGHT_SHAPES: SpotlightShape[] = ["rectangle", "rounded", "ellipse"];
const BLUR_STRENGTHS: BlurStrength[] = ["soft", "regular", "strong"];
const COUNTER_STYLES: CounterStyle[] = ["filled", "outlined", "plain"];
const SIZE_PRESETS: SizePreset[] = ["small", "regular", "large"];
const PRIMARY_TOOLS: Tool[] = ["arrow", "line", "box", "ellipse", "text", "pencil"];
const MORE_TOOLS: Tool[] = ["counter", "highlighter", "eraser", "spotlight", "blur", "blur-effect", "crop"];
type LayerAction = "back" | "backward" | "forward" | "front";
type CropAspectChoice = "free" | CropAspect;

const imageTransformLabel = (transform: ImageTransform) => {
  const rotation = transform.quarterTurns === 1
    ? "90° right"
    : transform.quarterTurns === 2
      ? "180°"
      : transform.quarterTurns === 3
        ? "90° left"
        : "Original";
  return transform.flipped ? `${rotation} · mirrored` : rotation;
};

const toolLabel = (tool: Tool) => tool === "blur"
  ? "Pixelate"
  : tool === "blur-effect"
    ? "Blur"
    : tool[0]!.toUpperCase() + tool.slice(1);

const toolForMark = (mark: Mark): Tool => mark.kind === "blur_effect" ? "blur-effect" : mark.kind;

const supportsStroke = (mark: Mark): mark is Extract<Mark, {
  kind: "arrow" | "line" | "box" | "ellipse" | "pencil" | "highlighter";
}> => ["arrow", "line", "box", "ellipse", "pencil", "highlighter"].includes(mark.kind);

const PREVIEW_IMAGE = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" width="1280" height="760" viewBox="0 0 1280 760">
    <rect width="1280" height="760" fill="whitesmoke"/>
    <rect width="1280" height="68" fill="white"/>
    <circle cx="38" cy="34" r="12" fill="tomato"/><circle cx="72" cy="34" r="12" fill="gold"/><circle cx="106" cy="34" r="12" fill="mediumseagreen"/>
    <rect x="160" y="22" width="340" height="24" rx="12" fill="gainsboro"/>
    <rect x="36" y="104" width="262" height="620" rx="18" fill="white"/>
    <rect x="70" y="144" width="126" height="18" rx="9" fill="slategray"/>
    <rect x="70" y="198" width="178" height="13" rx="6" fill="lightgray"/>
    <rect x="70" y="235" width="150" height="13" rx="6" fill="lightgray"/>
    <rect x="70" y="272" width="190" height="13" rx="6" fill="lightgray"/>
    <text x="348" y="152" font-family="system-ui" font-size="34" font-weight="700" fill="midnightblue">Campaign performance</text>
    <text x="348" y="188" font-family="system-ui" font-size="18" fill="slategray">A clean workspace for the annotation preview</text>
    <rect x="348" y="230" width="268" height="176" rx="18" fill="white"/>
    <rect x="640" y="230" width="268" height="176" rx="18" fill="white"/>
    <rect x="932" y="230" width="312" height="176" rx="18" fill="white"/>
    <text x="378" y="274" font-family="system-ui" font-size="16" fill="slategray">CAPTURES</text>
    <text x="378" y="342" font-family="system-ui" font-size="52" font-weight="700" fill="midnightblue">2,481</text>
    <text x="670" y="274" font-family="system-ui" font-size="16" fill="slategray">SAVED TIME</text>
    <text x="670" y="342" font-family="system-ui" font-size="52" font-weight="700" fill="midnightblue">18.4h</text>
    <text x="962" y="274" font-family="system-ui" font-size="16" fill="slategray">PRIVATE NOTE</text>
    <rect x="962" y="304" width="244" height="24" rx="8" fill="lightpink"/>
    <rect x="348" y="432" width="896" height="292" rx="18" fill="white"/>
    <polyline points="390,650 480,590 570,618 660,512 750,548 840,470 930,502 1040,414 1190,452" fill="none" stroke="royalblue" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
`)}`;

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

function destinationName(path: string) {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}

/**
 * Was four inline `<svg viewBox="0 0 20 20">` literals, plus UndoIcon below, plus
 * more in CaptureOverlay and PinCapture — an undocumented *third* icon family
 * with no `@phosphor-icons/react` in apps/mac/package.json at all. design-qa.md's
 * Loop-2 "one family" fix had only ever covered web. These now come from the same
 * 24-grid sources the web app uses, compiled by gen-tokens.mjs, so the two
 * surfaces are provably identical the way tokens.generated.css already makes the
 * palette identical. Family count goes 3 -> 2, not 2 -> 3.
 */
function ToolIcon({ tool }: { tool: Tool }) {
  return <CapsoGlyph name={tool === "blur-effect" ? "blur" : tool} />;
}

function UndoIcon() {
  return <CapsoGlyph name="undo" />;
}

function RedoIcon() {
  return <CapsoGlyph name="redo" />;
}

function Editor({
  capture,
  source,
  nativeRuntime,
}: {
  capture: AnnotationCapture;
  source: string;
  nativeRuntime: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const renderCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const resizeRef = useRef<HTMLDivElement | null>(null);
  const customColorInputRef = useRef<HTMLInputElement | null>(null);
  const customColorReturnFocusRef = useRef<HTMLElement | null>(null);
  const moreTriggerRef = useRef<HTMLButtonElement | null>(null);
  const moreFirstRef = useRef<HTMLButtonElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragGesture = useRef(new OverlayDragGesture(6));
  const dragMovedRef = useRef(false);
  const objectClipboardRef = useRef<{ mark: Mark; pasteCount: number } | null>(null);
  const anchorRef = useRef<{ x: number; y: number } | null>(null);
  const cropAnchorRef = useRef<{ x: number; y: number } | null>(null);
  const cropDraftRef = useRef<AnnotationCrop | null>(null);
  const cropDraftAspectRef = useRef<CropAspectChoice>("free");
  const drawingRef = useRef<Mark | null>(null);
  const eraserRef = useRef<{
    before: Mark[];
    points: AnnotationPoint[];
    after: Mark[];
  } | null>(null);
  const movingRef = useRef<{
    index: number;
    startX: number;
    startY: number;
    duplicate: boolean;
    moved: boolean;
    before: Mark;
    after: Mark;
  } | null>(null);
  const resizingRef = useRef<{
    index: number;
    handle: ResizeHandle;
    before: Mark;
    after: Mark;
  } | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [tool, setTool] = useState<Tool>("arrow");
  const [color, setColor] = useState<string>(DEFAULT_COLOR);
  const [customColors, setCustomColors] = useState<string[]>(() => (
    typeof window === "undefined" ? [] : readAnnotationCustomColors(window.localStorage)
  ));
  const [arrowStyle, setArrowStyle] = useState<ArrowStyle>(DEFAULT_ARROW_STYLE);
  const [strokeWeight, setStrokeWeight] = useState<StrokeWeight>(DEFAULT_STROKE_WEIGHT);
  const [highlighterOpacity, setHighlighterOpacity] = useState<HighlighterOpacity>(DEFAULT_HIGHLIGHTER_OPACITY);
  const [spotlightStrength, setSpotlightStrength] = useState<SpotlightStrength>(DEFAULT_SPOTLIGHT_STRENGTH);
  const [spotlightShape, setSpotlightShape] = useState<SpotlightShape>(DEFAULT_SPOTLIGHT_SHAPE);
  const [blurMode, setBlurMode] = useState<BlurMode>(DEFAULT_BLUR_MODE);
  const [blurStrength, setBlurStrength] = useState<BlurStrength>(DEFAULT_BLUR_STRENGTH);
  const [counterStyle, setCounterStyle] = useState<CounterStyle>(DEFAULT_COUNTER_STYLE);
  const [counterStart, setCounterStart] = useState(1);
  const [textSizePreset, setTextSizePreset] = useState<SizePreset>(DEFAULT_SIZE_PRESET);
  const [textStyle, setTextStyle] = useState<TextStyle>(DEFAULT_TEXT_STYLE);
  const [counterSizePreset, setCounterSizePreset] = useState<SizePreset>(DEFAULT_SIZE_PRESET);
  const [canvasZoom, setCanvasZoom] = useState(1);
  const [workspaceSize, setWorkspaceSize] = useState<{ width: number; height: number } | null>(null);
  const [shapeStyle, setShapeStyle] = useState<"outline" | "filled">("outline");
  const [cropAspect, setCropAspect] = useState<CropAspectChoice>("free");
  const [moreOpen, setMoreOpen] = useState(false);
  const [resizeOpen, setResizeOpen] = useState(false);
  const [editState, dispatchEdit] = useReducer(
    annotationEditReducer,
    capture.marks.length === 0
      && capture.crop === null
      && isDefaultImageTransform(capture.imageTransform)
      && capture.imageScale === DEFAULT_IMAGE_SCALE
      ? EMPTY_ANNOTATION_EDIT_STATE
      : {
          marks: capture.marks,
          crop: capture.crop,
          imageTransform: capture.imageTransform,
          imageScale: capture.imageScale,
          undo: [],
          redo: [],
        },
  );
  const marks = editState.marks;
  const imageTransform = editState.imageTransform;
  const imageScale = editState.imageScale;
  const [cropDraft, setCropDraft] = useState<AnnotationCrop | null>(null);
  const viewport = useMemo(() => editState.crop ?? {
    x: 0,
    y: 0,
    w: size?.w ?? 0,
    h: size?.h ?? 0,
  }, [editState.crop, size]);
  const resizedOutput = useMemo(
    () => imageScaleOutputSize(
      viewport.w || 1,
      viewport.h || 1,
      imageTransform,
      imageScale,
    ),
    [imageScale, imageTransform, viewport.h, viewport.w],
  );
  const [resizeDraft, setResizeDraft] = useState({ width: "", height: "" });

  useEffect(() => {
    if (viewport.w > 0 && viewport.h > 0) {
      setResizeDraft({
        width: String(resizedOutput.width),
        height: String(resizedOutput.height),
      });
    }
  }, [resizedOutput.height, resizedOutput.width, viewport.h, viewport.w]);
  const spotlightMark = marks.find(
    (mark): mark is Extract<Mark, { kind: "spotlight" }> => mark.kind === "spotlight",
  );
  const visibleSpotlightStrength = spotlightMark?.strength ?? spotlightStrength;
  const visibleSpotlightShape = spotlightMark?.spotlightShape ?? spotlightShape;
  const [drawing, setDrawing] = useState<Mark | null>(null);
  const [eraserPreview, setEraserPreview] = useState<{
    points: AnnotationPoint[];
    marks: Mark[];
  } | null>(null);
  const [typing, setTyping] = useState<{
    x: number;
    y: number;
    value: string;
    editingIndex?: number;
  } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const selectedMark = selected === null ? undefined : marks[selected];
  const styleKind = selectedMark?.kind ?? tool;
  const styleHasColor = styleKind !== "blur" && styleKind !== "blur_effect" && styleKind !== "blur-effect"
    && styleKind !== "spotlight" && styleKind !== "crop" && styleKind !== "eraser";
  const styleHasStroke = ["arrow", "line", "box", "ellipse", "pencil", "highlighter"].includes(styleKind);
  const styleHasHighlighter = styleKind === "highlighter";
  const styleHasArrow = styleKind === "arrow";
  const styleHasText = styleKind === "text";
  const styleHasShape = styleKind === "box" || styleKind === "ellipse";
  const styleHasSize = styleKind === "text" || styleKind === "counter";
  const styleHasCounter = styleKind === "counter";
  const styleHasBlur = styleKind === "blur_effect" || styleKind === "blur-effect";
  const visibleColor = selectedMark && "color" in selectedMark ? selectedMark.color : color;
  const visibleStrokeWeight = selectedMark && supportsStroke(selectedMark)
    ? selectedMark.strokeWeight ?? DEFAULT_STROKE_WEIGHT
    : strokeWeight;
  const visibleHighlighterOpacity = selectedMark?.kind === "highlighter"
    ? selectedMark.highlighterOpacity ?? DEFAULT_HIGHLIGHTER_OPACITY
    : highlighterOpacity;
  const visibleArrowStyle = selectedMark?.kind === "arrow"
    ? selectedMark.arrowStyle ?? DEFAULT_ARROW_STYLE
    : arrowStyle;
  const visibleTextStyle = selectedMark?.kind === "text"
    ? selectedMark.textStyle ?? DEFAULT_TEXT_STYLE
    : textStyle;
  const visibleBlurMode = selectedMark?.kind === "blur_effect"
    ? selectedMark.blurMode ?? DEFAULT_BLUR_MODE
    : blurMode;
  const visibleBlurStrength = selectedMark?.kind === "blur_effect"
    ? selectedMark.blurStrength ?? DEFAULT_BLUR_STRENGTH
    : blurStrength;
  const visibleCounterStyle = selectedMark?.kind === "counter"
    ? selectedMark.counterStyle ?? DEFAULT_COUNTER_STYLE
    : counterStyle;
  const visibleShapeStyle = selectedMark && (selectedMark.kind === "box" || selectedMark.kind === "ellipse")
    ? selectedMark.filled ? "filled" : "outline"
    : shapeStyle;
  const regularSelectedSize = styleKind === "text"
    ? textSizeFor(viewport.w || 800)
    : counterSizeFor(viewport.w || 800);
  const visibleSizePreset = selectedMark && (selectedMark.kind === "text" || selectedMark.kind === "counter")
    ? closestSizePreset(selectedMark.size, regularSelectedSize)
    : styleKind === "text" ? textSizePreset : counterSizePreset;
  const foregroundIndices = marks.flatMap((mark, index) => (
    mark.kind === "blur" || mark.kind === "blur_effect" || mark.kind === "spotlight" || mark.kind === "counter"
      ? []
      : [index]
  ));
  const selectedLayerPosition = selected === null ? -1 : foregroundIndices.indexOf(selected);
  const canReorderSelection = typing === null && selectedLayerPosition >= 0 && foregroundIndices.length > 1;
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [copying, setCopying] = useState(false);
  const [exporting, setExporting] = useState(false);
  const annotationActionInFlight = useRef<string | null>(null);
  const [notice, setNotice] = useState(
    capture.editingExisting
      ? `Editing revision ${capture.documentRevision} · protected original unchanged.`
      : "Draw on the image · original protected locally.",
  );
  const [noticeIsError, setNoticeIsError] = useState(false);

  function beginAnnotationAction(key: string) {
    if (annotationActionInFlight.current !== null) return false;
    annotationActionInFlight.current = key;
    return true;
  }

  function endAnnotationAction(key: string) {
    if (annotationActionInFlight.current !== key) return;
    annotationActionInFlight.current = null;
  }

  useEffect(() => {
    if (!nativeRuntime) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void (async () => {
      unlisten = await listen<AnnotationDragEnded>("annotation-drag-ended", (event) => {
        if (disposed || event.payload.sessionId !== capture.sessionId) return;
        dragGesture.current.reset();
        endAnnotationAction(`drag:${capture.sessionId}`);
        setDragging(false);
        setNoticeIsError(false);
        setNotice(event.payload.outcome === "dropped"
          ? "Shared a flattened copy · editable project remains open."
          : "Drag cancelled · editable project remains unchanged.");
      });
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [capture.sessionId, nativeRuntime]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const update = () => {
      const styles = getComputedStyle(workspace);
      const width = workspace.clientWidth
        - Number.parseFloat(styles.paddingLeft)
        - Number.parseFloat(styles.paddingRight);
      const height = workspace.clientHeight
        - Number.parseFloat(styles.paddingTop)
        - Number.parseFloat(styles.paddingBottom);
      setWorkspaceSize({ width: Math.max(1, width), height: Math.max(1, height) });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);

  const fittedCanvas = useMemo(() => workspaceSize
    ? fitCanvasSize(
        workspaceSize.width,
        workspaceSize.height,
        resizedOutput.width,
        resizedOutput.height,
      )
    : null, [resizedOutput.height, resizedOutput.width, workspaceSize]);
  const displayedCanvas = useMemo(
    () => fittedCanvas ? zoomedCanvasSize(fittedCanvas, canvasZoom) : null,
    [canvasZoom, fittedCanvas],
  );

  useEffect(() => {
    const image = new Image();
    image.onload = () => {
      imageRef.current = image;
      setSize({ w: image.naturalWidth, h: image.naturalHeight });
    };
    image.onerror = () => {
      setNotice("The saved capture could not be opened for annotation.");
      setNoticeIsError(true);
    };
    image.src = source;
  }, [source]);

  useEffect(() => {
    if (!moreOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [moreOpen]);

  useEffect(() => {
    if (!resizeOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!resizeRef.current?.contains(event.target as Node)) setResizeOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [resizeOpen]);

  const fitTextToViewport = useCallback((mark: Extract<Mark, { kind: "text" }>) => {
    const fitted = fitTextWithinCanvas(
      { ...mark, x: mark.x - viewport.x, y: mark.y - viewport.y },
      viewport.w || 800,
      viewport.h || 600,
    );
    return { ...fitted, x: fitted.x + viewport.x, y: fitted.y + viewport.y };
  }, [viewport]);

  const repaint = useCallback((includeChrome = true) => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image || viewport.w <= 0 || viewport.h <= 0) return;
    const renderCanvas = renderCanvasRef.current ?? document.createElement("canvas");
    renderCanvasRef.current = renderCanvas;
    if (renderCanvas.width !== viewport.w) renderCanvas.width = viewport.w;
    if (renderCanvas.height !== viewport.h) renderCanvas.height = viewport.h;
    const context = renderCanvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, viewport.w, viewport.h);
    context.drawImage(
      image,
      viewport.x,
      viewport.y,
      viewport.w,
      viewport.h,
      0,
      0,
      viewport.w,
      viewport.h,
    );
    const previewMarks = eraserPreview?.marks ?? marks;
    const visibleMarks = typing?.editingIndex === undefined
      ? previewMarks
      : previewMarks.filter((_, index) => index !== typing.editingIndex);
    const localized: Mark[] = [];
    for (const mark of drawing ? [...visibleMarks, drawing] : visibleMarks) {
      const local = translate(mark, -viewport.x, -viewport.y);
      if (local.kind !== "blur" && local.kind !== "blur_effect") {
        localized.push(local);
        continue;
      }
      const left = Math.max(0, local.x);
      const top = Math.max(0, local.y);
      const right = Math.min(viewport.w, local.x + local.w);
      const bottom = Math.min(viewport.h, local.y + local.h);
      if (right > left && bottom > top) {
        localized.push({ ...local, x: left, y: top, w: right - left, h: bottom - top });
      }
    }
    paintAll(context, localized, viewport.w);
    if (includeChrome && eraserPreview) {
      const last = eraserPreview.points.at(-1);
      if (last) {
        context.save();
        context.strokeStyle = DEFAULT_COLOR;
        context.lineWidth = Math.max(2, Math.round(viewport.w / 420));
        context.setLineDash([6, 4]);
        context.beginPath();
        context.arc(
          last.x - viewport.x,
          last.y - viewport.y,
          eraserRadiusFor(viewport.w),
          0,
          Math.PI * 2,
        );
        context.stroke();
        context.restore();
      }
    }
    const picked = movingRef.current?.duplicate && drawing
      ? drawing
      : selected === null ? undefined : marks[selected];
    if (includeChrome && picked && typing?.editingIndex === undefined) {
      paintSelection(context, translate(picked, -viewport.x, -viewport.y), viewport.w);
    }
    if (includeChrome && cropDraft) {
      const local = {
        x: cropDraft.x - viewport.x,
        y: cropDraft.y - viewport.y,
        w: cropDraft.w,
        h: cropDraft.h,
      };
      context.save();
      context.fillStyle = "rgba(0,0,0,0.5)";
      context.fillRect(0, 0, viewport.w, local.y);
      context.fillRect(0, local.y + local.h, viewport.w, viewport.h - local.y - local.h);
      context.fillRect(0, local.y, local.x, local.h);
      context.fillRect(local.x + local.w, local.y, viewport.w - local.x - local.w, local.h);
      context.strokeStyle = DEFAULT_COLOR;
      context.lineWidth = Math.max(2, Math.round(viewport.w / 420));
      context.setLineDash([8, 6]);
      context.strokeRect(local.x, local.y, local.w, local.h);
      context.restore();
    }
    const naturalOutput = imageTransformOutputSize(viewport.w, viewport.h, imageTransform);
    const output = imageScaleOutputSize(viewport.w, viewport.h, imageTransform, imageScale);
    if (canvas.width !== output.width) canvas.width = output.width;
    if (canvas.height !== output.height) canvas.height = output.height;
    const outputContext = canvas.getContext("2d");
    if (!outputContext) return;
    outputContext.setTransform(1, 0, 0, 1, 0, 0);
    outputContext.clearRect(0, 0, output.width, output.height);
    const [a, b, c, d, e, f] = imageTransformMatrix(viewport.w, viewport.h, imageTransform);
    const scaleX = output.width / naturalOutput.width;
    const scaleY = output.height / naturalOutput.height;
    outputContext.setTransform(
      a * scaleX,
      b * scaleY,
      c * scaleX,
      d * scaleY,
      e * scaleX,
      f * scaleY,
    );
    outputContext.drawImage(renderCanvas, 0, 0);
    outputContext.setTransform(1, 0, 0, 1, 0, 0);
  }, [cropDraft, drawing, eraserPreview, imageScale, imageTransform, marks, selected, typing?.editingIndex, viewport]);

  useEffect(() => {
    if (size) repaint();
  }, [repaint, size]);

  const toImage = (event: React.PointerEvent | React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return null;
    const naturalOutput = imageTransformOutputSize(viewport.w, viewport.h, imageTransform);
    const local = imagePointFromOutput({
      x: ((event.clientX - bounds.left) / bounds.width) * naturalOutput.width,
      y: ((event.clientY - bounds.top) / bounds.height) * naturalOutput.height,
    }, viewport.w, viewport.h, imageTransform);
    return { x: viewport.x + local.x, y: viewport.y + local.y };
  };

  const detectSmartHighlightAt = (at: AnnotationPoint) => {
    const image = imageRef.current;
    if (!image) return null;
    const width = Math.min(240, image.naturalWidth);
    const height = Math.min(96, image.naturalHeight);
    const left = Math.max(0, Math.min(image.naturalWidth - width, Math.round(at.x - width / 2)));
    const top = Math.max(0, Math.min(image.naturalHeight - height, Math.round(at.y - height / 2)));
    const sample = document.createElement("canvas");
    sample.width = width;
    sample.height = height;
    const context = sample.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    try {
      context.drawImage(image, left, top, width, height, 0, 0, width, height);
      const band = detectSmartHighlightBand(
        context.getImageData(0, 0, width, height).data,
        width,
        height,
        at.x - left,
        at.y - top,
      );
      return band ? { y: top + band.centerY, width: band.strokeWidth } : null;
    } catch {
      return null;
    }
  };

  const commit = (mark: Mark) => {
    if (!isDegenerate(mark)) dispatchEdit({ type: "add", mark });
  };

  const undo = useCallback(() => {
    const operation = editState.undo.at(-1);
    dispatchEdit({ type: "undo" });
    setSelected((current) => selectionAfterReverse(current, operation));
    if (operation?.kind === "crop") {
      setNotice(operation.before
        ? `Crop restored at ${operation.before.w} × ${operation.before.h} px.`
        : "Protected-original dimensions restored. Redo reapplies the crop.");
      setNoticeIsError(false);
    } else if (operation?.kind === "transform") {
      setNotice(`Orientation restored to ${imageTransformLabel(operation.before)}.`);
      setNoticeIsError(false);
    } else if (operation?.kind === "resize") {
      const output = imageScaleOutputSize(viewport.w, viewport.h, imageTransform, operation.before);
      setNotice(`Output restored to ${output.width} × ${output.height} px.`);
      setNoticeIsError(false);
    }
  }, [editState.undo, imageTransform, viewport.h, viewport.w]);

  const redo = useCallback(() => {
    const operation = editState.redo.at(-1);
    dispatchEdit({ type: "redo" });
    setSelected((current) => selectionAfterApply(current, operation));
    if (operation?.kind === "crop") {
      setNotice(operation.after
        ? `Crop reapplied at ${operation.after.w} × ${operation.after.h} px.`
        : "Protected-original dimensions restored. Undo returns to the cropped frame.");
      setNoticeIsError(false);
    } else if (operation?.kind === "transform") {
      setNotice(`Orientation reapplied as ${imageTransformLabel(operation.after)}.`);
      setNoticeIsError(false);
    } else if (operation?.kind === "resize") {
      const output = imageScaleOutputSize(viewport.w, viewport.h, imageTransform, operation.after);
      setNotice(`Output reapplied at ${output.width} × ${output.height} px.`);
      setNoticeIsError(false);
    }
  }, [editState.redo, imageTransform, viewport.h, viewport.w]);

  const cancel = useCallback(async () => {
    const actionKey = `cancel:${capture.sessionId}`;
    if (saving || dragging || copying || exporting || !beginAnnotationAction(actionKey)) return;
    if (!nativeRuntime) {
      dispatchEdit({ type: "reset" });
      setSelected(null);
      setNotice("Preview reset. In the Mac app, Cancel returns to Quick Access.");
      endAnnotationAction(actionKey);
      return;
    }
    try {
      await invoke<boolean>("cancel_annotation_editor", {
        path: capture.path,
        presentationId: capture.presentationId,
        sessionId: capture.sessionId,
      });
    } catch (error) {
      setNotice(`Could not close the editor: ${String(error)}`);
      setNoticeIsError(true);
    } finally {
      endAnnotationAction(actionKey);
    }
  }, [capture, copying, dragging, exporting, nativeRuntime, saving]);

  const changeCanvasZoom = useCallback((direction: CanvasZoomDirection) => {
    const next = canvasZoomStep(canvasZoom, direction);
    setCanvasZoom(next);
    setNotice(`Canvas zoom ${Math.round(next * 100)}% · exported pixels stay unchanged.`);
    setNoticeIsError(false);
  }, [canvasZoom]);

  const resetCanvasZoom = useCallback(() => {
    setCanvasZoom(1);
    setNotice("Canvas fitted to the workspace · exported pixels stay unchanged.");
    setNoticeIsError(false);
  }, []);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (typing || saving || dragging || copying || exporting) return;
      const modifier = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const editingControl = event.target instanceof Element
        && event.target.matches("input, textarea, [contenteditable='true']");
      if (modifier && editingControl) return;
      if (event.key === "Escape" && resizeOpen) {
        event.preventDefault();
        setResizeOpen(false);
      } else if (event.key === "Escape" && moreOpen) {
        event.preventDefault();
        setMoreOpen(false);
        moreTriggerRef.current?.focus();
      } else if (modifier && (key === "+" || key === "=")) {
        event.preventDefault();
        changeCanvasZoom("in");
      } else if (modifier && key === "-") {
        event.preventDefault();
        changeCanvasZoom("out");
      } else if (modifier && key === "0") {
        event.preventDefault();
        resetCanvasZoom();
      } else if (modifier && ((event.shiftKey && key === "z") || (event.ctrlKey && key === "y"))) {
        event.preventDefault();
        redo();
      } else if (modifier && key === "z") {
        event.preventDefault();
        undo();
      } else if (modifier && key === "d" && selected !== null) {
        event.preventDefault();
        const copy = duplicateSelectedMark(marks, selected, counterStart);
        if (copy) {
          dispatchEdit({ type: "add", mark: copy });
          setSelected(marks.length);
          setNotice("Duplicate selected · ⌘Z removes only the copy.");
        } else {
          setNotice("Spotlight stays single. Move or resize the existing focus region.");
        }
        setNoticeIsError(false);
      } else if (modifier && key === "c" && selected !== null) {
        event.preventDefault();
        const copiedMark = copySelectedMark(marks, selected);
        if (copiedMark) {
          objectClipboardRef.current = { mark: copiedMark, pasteCount: 0 };
          setNotice("Object copied · ⌘V pastes an independent editable copy.");
          setNoticeIsError(false);
        }
      } else if (modifier && key === "v") {
        const clipboard = objectClipboardRef.current;
        if (!clipboard) return;
        event.preventDefault();
        const nextPasteCount = clipboard.pasteCount + 1;
        const pastedMark = pasteCopiedMark(clipboard.mark, marks, nextPasteCount);
        if (pastedMark) {
          clipboard.pasteCount = nextPasteCount;
          dispatchEdit({ type: "add", mark: pastedMark });
          setSelected(marks.length);
          setNotice("Pasted object · ⌘Z removes only the pasted copy.");
        } else {
          setNotice("Spotlight stays single. Delete the current focus region before pasting another.");
        }
        setNoticeIsError(false);
      } else if ((event.key === "Backspace" || event.key === "Delete") && selected !== null) {
        event.preventDefault();
        dispatchEdit({ type: "delete", index: selected });
        setSelected(null);
      } else if (
        selected !== null
        && event.target === canvasRef.current
        && ["arrowleft", "arrowright", "arrowup", "arrowdown"].includes(key)
      ) {
        const vector = {
          arrowleft: { x: -1, y: 0 },
          arrowright: { x: 1, y: 0 },
          arrowup: { x: 0, y: -1 },
          arrowdown: { x: 0, y: 1 },
        }[key];
        const before = marks[selected];
        if (vector && before) {
          event.preventDefault();
          const distance = event.shiftKey ? 10 : 1;
          const sourceVector = imageDeltaFromOutput(
            vector.x * distance,
            vector.y * distance,
            imageTransform,
          );
          dispatchEdit({
            type: "update",
            index: selected,
            before,
            after: translate(before, sourceVector.x, sourceVector.y),
          });
        }
      } else if (
        event.key === "Enter"
        && selected !== null
        && event.target === canvasRef.current
        && marks[selected]?.kind === "text"
      ) {
        event.preventDefault();
        beginTextEdit(selected);
      } else if (event.key === "Escape") {
        if (selected !== null) setSelected(null);
        else void cancel();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [
    cancel,
    changeCanvasZoom,
    copying,
    counterStart,
    dragging,
    exporting,
    imageTransform,
    marks,
    moreOpen,
    redo,
    resetCanvasZoom,
    resizeOpen,
    selected,
    saving,
    typing,
    undo,
  ]);

  function start(event: React.PointerEvent<HTMLCanvasElement>) {
    if (saving || dragging || copying || exporting || typing || event.button !== 0) return;
    const at = toImage(event);
    if (!at) return;
    if (tool === "crop") {
      setSelected(null);
      event.currentTarget.setPointerCapture(event.pointerId);
      cropAnchorRef.current = at;
      cropDraftAspectRef.current = cropAspect;
      cropDraftRef.current = { x: Math.floor(at.x), y: Math.floor(at.y), w: 0, h: 0 };
      setCropDraft(cropDraftRef.current);
      return;
    }
    if (tool === "eraser") {
      setSelected(null);
      event.currentTarget.setPointerCapture(event.pointerId);
      const after = eraseFreehandMarks(marks, [at], viewport.w || 800);
      eraserRef.current = { before: marks, points: [at], after };
      setEraserPreview({ points: [at], marks: after });
      return;
    }
    const selectedIndex = selected;
    const selectedMark = selectedIndex === null ? undefined : marks[selectedIndex];
    if (selectedIndex !== null && selectedMark) {
      const handle = hitResizeHandle(selectedMark, at.x, at.y, viewport.w);
      if (handle) {
        event.currentTarget.setPointerCapture(event.pointerId);
        resizingRef.current = {
          index: selectedIndex,
          handle,
          before: selectedMark,
          after: selectedMark,
        };
        return;
      }
    }
    const hit = hitTest(marks, at.x, at.y, viewport.w);
    if (hit !== null) {
      event.currentTarget.setPointerCapture(event.pointerId);
      const mark = marks[hit]!;
      const duplicate = event.altKey && mark.kind !== "spotlight";
      const movingMark = duplicate && mark.kind === "counter"
        ? { ...mark, value: nextCounterValue(marks, counterStart) }
        : mark;
      movingRef.current = {
        index: hit,
        startX: at.x,
        startY: at.y,
        duplicate,
        moved: false,
        before: movingMark,
        after: movingMark,
      };
      setSelected(duplicate ? null : hit);
      if (duplicate) setDrawing(movingMark);
      if (mark.kind === "spotlight") {
        setSpotlightStrength(mark.strength ?? DEFAULT_SPOTLIGHT_STRENGTH);
        setSpotlightShape(mark.spotlightShape ?? DEFAULT_SPOTLIGHT_SHAPE);
      }
      if (mark.kind === "blur_effect") {
        setBlurMode(mark.blurMode ?? DEFAULT_BLUR_MODE);
        setBlurStrength(mark.blurStrength ?? DEFAULT_BLUR_STRENGTH);
      }
      if (mark.kind === "counter") {
        setCounterStyle(mark.counterStyle ?? DEFAULT_COUNTER_STYLE);
      }
      if (mark.kind === "highlighter") {
        setHighlighterOpacity(mark.highlighterOpacity ?? DEFAULT_HIGHLIGHTER_OPACITY);
      }
      return;
    }
    setSelected(null);
    if (tool === "spotlight" && marks.some((mark) => mark.kind === "spotlight")) {
      setNotice("One spotlight is already active. Move or delete it before drawing another.");
      setNoticeIsError(false);
      return;
    }
    if (tool === "counter") {
      commit({
        kind: "counter",
        color,
        x: at.x,
        y: at.y,
        value: nextCounterValue(marks, counterStart),
        size: sizeForPreset(counterSizeFor(viewport.w || 800), counterSizePreset),
        counterStyle,
      });
      return;
    }
    if (tool === "text") {
      setTyping({ ...at, value: "" });
      return;
    }
    const smartHighlight = tool === "highlighter" && !event.metaKey
      ? detectSmartHighlightAt(at)
      : null;
    event.currentTarget.setPointerCapture(event.pointerId);
    anchorRef.current = at;
    const started: Mark = tool === "arrow"
      ? { kind: "arrow", color, strokeWeight, arrowStyle, x1: at.x, y1: at.y, x2: at.x, y2: at.y }
      : tool === "line"
        ? { kind: "line", color, strokeWeight, x1: at.x, y1: at.y, x2: at.x, y2: at.y }
      : tool === "pencil"
        ? { kind: tool, color, strokeWeight, points: [at] }
      : tool === "highlighter"
        ? {
            kind: tool,
            color,
            strokeWeight,
            ...(highlighterOpacity === DEFAULT_HIGHLIGHTER_OPACITY ? {} : { highlighterOpacity }),
            points: [{ ...at, y: smartHighlight?.y ?? at.y }],
            ...(smartHighlight ? { smartWidth: smartHighlight.width } : {}),
          }
      : tool === "box" || tool === "ellipse"
        ? {
            kind: tool,
            color,
            strokeWeight,
            x: at.x,
            y: at.y,
            w: 0,
            h: 0,
            filled: shapeStyle === "filled",
          }
        : tool === "spotlight"
          ? {
              kind: "spotlight",
              x: at.x,
              y: at.y,
              w: 0,
              h: 0,
              strength: spotlightStrength,
              spotlightShape,
            }
        : tool === "blur-effect"
          ? {
              kind: "blur_effect",
              x: at.x,
              y: at.y,
              w: 0,
              h: 0,
              blurMode,
              blurStrength,
            }
        : { kind: "blur", x: at.x, y: at.y, w: 0, h: 0 };
    drawingRef.current = started;
    setDrawing(started);
  }

  function editTextAt(event: React.MouseEvent<HTMLCanvasElement>) {
    if (saving || dragging || copying || exporting || typing || tool === "eraser") return;
    const at = toImage(event);
    if (!at) return;
    const hit = hitTest(marks, at.x, at.y, viewport.w);
    if (hit !== null && marks[hit]?.kind === "text") {
      event.preventDefault();
      beginTextEdit(hit);
    }
  }

  function move(event: React.PointerEvent<HTMLCanvasElement>) {
    const cropAnchor = cropAnchorRef.current;
    if (cropAnchor) {
      const at = toImage(event);
      if (!at) return;
      const effectiveAspect: CropAspectChoice = event.shiftKey ? "square" : cropAspect;
      cropDraftAspectRef.current = effectiveAspect;
      cropDraftRef.current = effectiveAspect === "free"
        ? cropFromDrag(cropAnchor.x, cropAnchor.y, at.x, at.y, viewport)
        : cropFromDragWithAspect(
            cropAnchor.x,
            cropAnchor.y,
            at.x,
            at.y,
            viewport,
            effectiveAspect,
          );
      setCropDraft(cropDraftRef.current);
      return;
    }
    const erasing = eraserRef.current;
    if (erasing) {
      const at = toImage(event);
      if (!at) return;
      const previous = erasing.points.at(-1);
      if (previous && Math.hypot(at.x - previous.x, at.y - previous.y) < Math.max(1, (viewport.w || 800) / 640)) {
        return;
      }
      const points = [...erasing.points, at];
      const after = eraseFreehandMarks(erasing.before, points, viewport.w || 800);
      eraserRef.current = { ...erasing, points, after };
      setEraserPreview({ points, marks: after });
      return;
    }
    const resizing = resizingRef.current;
    if (resizing) {
      const at = toImage(event);
      if (!at) return;
      const after = resizeMark(resizing.before, resizing.handle, at.x, at.y);
      if (isDegenerate(after)) return;
      resizingRef.current = { ...resizing, after };
      dispatchEdit({ type: "preview_move", index: resizing.index, mark: after });
      return;
    }
    const moving = movingRef.current;
    if (moving) {
      const at = toImage(event);
      if (!at) return;
      const pointerDelta = { x: at.x - moving.startX, y: at.y - moving.startY };
      const delta = event.shiftKey
        ? axisLockedDelta(pointerDelta.x, pointerDelta.y)
        : pointerDelta;
      const after = translate(moving.before, delta.x, delta.y);
      movingRef.current = {
        ...moving,
        after,
        moved: Math.hypot(pointerDelta.x, pointerDelta.y) >= Math.max(1, viewport.w / 640),
      };
      if (moving.duplicate) setDrawing(after);
      else dispatchEdit({ type: "preview_move", index: moving.index, mark: after });
      return;
    }
    const anchor = anchorRef.current;
    const active = drawingRef.current;
    const at = toImage(event);
    if (!anchor || !active || !at) return;
    const next: Mark = active.kind === "arrow" || active.kind === "line"
      ? { ...active, x2: at.x, y2: at.y }
      : active.kind === "pencil"
        ? appendFreehandPoint(active, at, viewport.w || 800)
      : active.kind === "highlighter"
        ? appendFreehandPoint(
            active,
            active.smartWidth === undefined ? at : { x: at.x, y: active.points[0]?.y ?? at.y },
            viewport.w || 800,
          )
      : active.kind === "box" || active.kind === "ellipse"
        ? {
            ...active,
            ...(event.shiftKey
              ? rectFromSquareDrag(anchor.x, anchor.y, at.x, at.y)
              : rectFrom(anchor.x, anchor.y, at.x, at.y)),
          }
        : { ...active, ...rectFrom(anchor.x, anchor.y, at.x, at.y) };
    drawingRef.current = next;
    setDrawing(next);
  }

  function end() {
    if (cropAnchorRef.current) {
      cropAnchorRef.current = null;
      const committedCrop = cropDraftRef.current;
      cropDraftRef.current = null;
      if (committedCrop && !isDegenerateCrop(committedCrop)) {
        dispatchEdit({ type: "crop", crop: committedCrop });
        const aspectLabel = cropDraftAspectRef.current === "square"
          ? "1:1"
          : cropDraftAspectRef.current;
        setNotice(
          `Crop applied at ${committedCrop.w} × ${committedCrop.h} px${aspectLabel === "free" ? "" : ` (${aspectLabel})`}. Undo restores the previous frame.`,
        );
        setNoticeIsError(false);
      } else {
        setNotice("Crop must be at least 16 × 16 source pixels.");
        setNoticeIsError(true);
      }
      setCropDraft(null);
      return;
    }
    const erasing = eraserRef.current;
    if (erasing) {
      eraserRef.current = null;
      setEraserPreview(null);
      dispatchEdit({ type: "erase", marks: erasing.after });
      setNotice(erasing.after === erasing.before
        ? "No Pencil or Highlighter ink was touched."
        : "Ink erased. Undo restores it exactly.");
      setNoticeIsError(false);
      return;
    }
    const resizing = resizingRef.current;
    if (resizing) {
      dispatchEdit({
        type: "commit_move",
        index: resizing.index,
        before: resizing.before,
        after: resizing.after,
      });
      resizingRef.current = null;
      return;
    }
    const moving = movingRef.current;
    if (moving) {
      if (moving.duplicate) {
        if (moving.moved) {
          dispatchEdit({ type: "add", mark: moving.after });
          setSelected(marks.length);
          setNotice("Duplicate placed as one reversible edit. Undo removes only the copy.");
          setNoticeIsError(false);
        } else {
          setSelected(moving.index);
        }
        setDrawing(null);
        movingRef.current = null;
        return;
      }
      dispatchEdit({
        type: "commit_move",
        index: moving.index,
        before: moving.before,
        after: moving.after,
      });
      movingRef.current = null;
      return;
    }
    const active = drawingRef.current;
    if (!active) return;
    const valid = !isDegenerate(active);
    commit(active);
    if (valid && active.kind === "highlighter") {
      setNotice(active.smartWidth === undefined
        ? "Free highlight: Smart snap bypassed or unavailable."
        : `Smart Highlighter: ${Math.round(active.smartWidth)} px text row.`);
      setNoticeIsError(false);
    }
    drawingRef.current = null;
    anchorRef.current = null;
    setDrawing(null);
  }

  function cancelPointer() {
    const moving = movingRef.current;
    if (moving?.duplicate) {
      movingRef.current = null;
      setDrawing(null);
      setSelected(moving.index);
      setNotice("Duplicate cancelled. The original mark is unchanged.");
      setNoticeIsError(false);
      return;
    }
    if (eraserRef.current) {
      eraserRef.current = null;
      setEraserPreview(null);
      setNotice("Erase cancelled. Existing ink is unchanged.");
      setNoticeIsError(false);
      return;
    }
    if (cropAnchorRef.current) {
      cropAnchorRef.current = null;
      cropDraftRef.current = null;
      setCropDraft(null);
      setNotice("Crop cancelled. The current frame is unchanged.");
      setNoticeIsError(false);
      return;
    }
    end();
  }

  function commitText() {
    if (!typing) return;
    const editingExisting = typing.editingIndex !== undefined;
    const value = typing.value.trim();
    if (!value) {
      setNotice("Text cannot be empty. Type a label or press Escape to keep the original.");
      setNoticeIsError(true);
      return;
    }
    if (typing.editingIndex !== undefined) {
      const before = marks[typing.editingIndex];
      if (before?.kind === "text") {
        const after = fitTextToViewport({ ...before, text: value });
        dispatchEdit({
          type: "update",
          index: typing.editingIndex,
          before,
          after,
        });
        setSelected(typing.editingIndex);
      }
    } else {
      commit(fitTextToViewport({
        kind: "text",
        color,
        x: typing.x,
        y: typing.y,
        text: value,
        size: sizeForPreset(textSizeFor(viewport.w || 800), textSizePreset),
        textStyle,
      }));
    }
    setNotice(editingExisting
      ? "Text updated. Undo restores the exact previous label and style."
      : "Text added. Select it later to change its content or style.");
    setNoticeIsError(false);
    setTyping(null);
  }

  function beginTextEdit(index: number) {
    const mark = marks[index];
    if (mark?.kind !== "text") return;
    setSelected(index);
    setTyping({ x: mark.x, y: mark.y, value: mark.text, editingIndex: index });
    setNotice("Editing text. Return applies the change; Escape keeps the original.");
    setNoticeIsError(false);
  }

  function updateSelectedMark(transform: (mark: Mark) => Mark) {
    if (selected === null) return;
    const before = marks[selected];
    if (!before) return;
    dispatchEdit({ type: "update", index: selected, before, after: transform(before) });
  }

  function changeColor(next: string) {
    setColor(next);
    if (selectedMark && "color" in selectedMark) {
      updateSelectedMark((mark) => "color" in mark ? { ...mark, color: next } : mark);
    }
  }

  function chooseAndSaveCustomColor(next: string) {
    if (!isAnnotationHexColor(next)) return;
    changeColor(next.toLowerCase());
    const saved = saveAnnotationCustomColor(window.localStorage, customColors, next);
    setCustomColors(saved);
    const persisted = saved.includes(next.toLowerCase());
    setNotice(persisted
      ? `Custom color ${next.toUpperCase()} saved on this Mac.`
      : "Custom color applied for this edit, but it could not be saved on this Mac.");
    setNoticeIsError(!persisted);
    customColorReturnFocusRef.current?.focus();
  }

  function openCustomColorPicker(returnFocus: HTMLElement) {
    customColorReturnFocusRef.current = returnFocus;
    customColorInputRef.current?.click();
  }

  function changeStrokeWeight(next: StrokeWeight) {
    setStrokeWeight(next);
    if (selectedMark && supportsStroke(selectedMark)) {
      updateSelectedMark((mark) => {
        if (!supportsStroke(mark)) return mark;
        if (mark.kind === "highlighter") {
          const { smartWidth: _smartWidth, ...manual } = mark;
          return { ...manual, strokeWeight: next };
        }
        return { ...mark, strokeWeight: next };
      });
    }
  }

  function changeHighlighterOpacity(next: HighlighterOpacity) {
    setHighlighterOpacity(next);
    if (selectedMark?.kind === "highlighter") {
      updateSelectedMark((mark) => {
        if (mark.kind !== "highlighter") return mark;
        if (next === DEFAULT_HIGHLIGHTER_OPACITY) {
          const { highlighterOpacity: _opacity, ...legacyDefault } = mark;
          return legacyDefault;
        }
        return { ...mark, highlighterOpacity: next };
      });
    }
  }

  function changeArrowStyle(next: ArrowStyle) {
    setArrowStyle(next);
    if (selectedMark?.kind === "arrow") {
      updateSelectedMark((mark) => mark.kind === "arrow" ? { ...mark, arrowStyle: next } : mark);
    }
  }

  function changeTextStyle(next: TextStyle) {
    setTextStyle(next);
    if (selectedMark?.kind === "text") {
      updateSelectedMark((mark) => mark.kind === "text"
        ? fitTextToViewport({ ...mark, textStyle: next })
        : mark);
    }
  }

  function changeShapeStyle(next: "outline" | "filled") {
    setShapeStyle(next);
    if (selectedMark?.kind === "box" || selectedMark?.kind === "ellipse") {
      updateSelectedMark((mark) => mark.kind === "box" || mark.kind === "ellipse"
        ? { ...mark, filled: next === "filled" }
        : mark);
    }
  }

  function changeSizePreset(next: SizePreset) {
    if (styleKind === "text") setTextSizePreset(next);
    if (styleKind === "counter") setCounterSizePreset(next);
    if (selectedMark?.kind === "text" || selectedMark?.kind === "counter") {
      const regular = selectedMark.kind === "text"
        ? textSizeFor(viewport.w || 800)
        : counterSizeFor(viewport.w || 800);
      updateSelectedMark((mark) => {
        if (mark.kind === "text") {
          return fitTextToViewport({ ...mark, size: sizeForPreset(regular, next) });
        }
        return mark.kind === "counter" ? { ...mark, size: sizeForPreset(regular, next) } : mark;
      });
    }
  }

  function changeCounterStyle(next: CounterStyle) {
    setCounterStyle(next);
    if (selectedMark?.kind === "counter") {
      updateSelectedMark((mark) => mark.kind === "counter"
        ? { ...mark, counterStyle: next }
        : mark);
    }
  }

  function changeSpotlightStrength(next: SpotlightStrength) {
    setSpotlightStrength(next);
    const index = selected !== null && marks[selected]?.kind === "spotlight"
      ? selected
      : marks.findIndex((mark) => mark.kind === "spotlight");
    const before = index < 0 ? undefined : marks[index];
    if (before?.kind !== "spotlight" || (before.strength ?? DEFAULT_SPOTLIGHT_STRENGTH) === next) return;
    dispatchEdit({
      type: "update",
      index,
      before,
      after: { ...before, strength: next },
    });
    setSelected(index);
  }

  function changeSpotlightShape(next: SpotlightShape) {
    setSpotlightShape(next);
    const index = selected !== null && marks[selected]?.kind === "spotlight"
      ? selected
      : marks.findIndex((mark) => mark.kind === "spotlight");
    const before = index < 0 ? undefined : marks[index];
    if (before?.kind !== "spotlight" || (before.spotlightShape ?? DEFAULT_SPOTLIGHT_SHAPE) === next) return;
    dispatchEdit({
      type: "update",
      index,
      before,
      after: { ...before, spotlightShape: next },
    });
    setSelected(index);
  }

  function changeBlurMode(next: BlurMode) {
    setBlurMode(next);
    if (selectedMark?.kind === "blur_effect") {
      updateSelectedMark((mark) => mark.kind === "blur_effect"
        ? { ...mark, blurMode: next }
        : mark);
    }
  }

  function changeBlurStrength(next: BlurStrength) {
    setBlurStrength(next);
    if (selectedMark?.kind === "blur_effect") {
      updateSelectedMark((mark) => mark.kind === "blur_effect"
        ? { ...mark, blurStrength: next }
        : mark);
    }
  }

  function reorderSelected(action: LayerAction) {
    if (typing || selected === null || selectedLayerPosition < 0) return;
    const finalPosition = foregroundIndices.length - 1;
    const targetPosition = action === "back"
      ? 0
      : action === "front"
        ? finalPosition
        : action === "backward"
          ? Math.max(0, selectedLayerPosition - 1)
          : Math.min(finalPosition, selectedLayerPosition + 1);
    const target = foregroundIndices[targetPosition];
    if (target === undefined || target === selected) return;
    dispatchEdit({ type: "reorder", from: selected, to: target });
    setSelected(target);
  }

  function chooseTool(next: Tool, returnFocus = false) {
    setTyping(null);
    setTool(next);
    setSelected(null);
    setMoreOpen(false);
    if (returnFocus) requestAnimationFrame(() => moreTriggerRef.current?.focus());
  }

  function applyImageTransform(action: ImageTransformAction) {
    const next = updateImageTransform(imageTransform, action);
    if (next.quarterTurns === imageTransform.quarterTurns && next.flipped === imageTransform.flipped) return;
    dispatchEdit({ type: "transform", imageTransform: next });
    setNotice(`${imageTransformLabel(next)} · source marks unchanged.`);
    setNoticeIsError(false);
  }

  function commitImageResize(dimension: "width" | "height") {
    const target = Number(resizeDraft[dimension]);
    const resetDraft = () => setResizeDraft({
      width: String(resizedOutput.width),
      height: String(resizedOutput.height),
    });
    if (!Number.isSafeInteger(target) || target < 1) {
      resetDraft();
      setNotice("Resize dimensions must be whole positive pixels.");
      setNoticeIsError(true);
      return;
    }
    const nextScale = imageScaleForOutputDimension(
      target,
      dimension,
      viewport.w,
      viewport.h,
      imageTransform,
    );
    if (!isValidImageScale(viewport.w, viewport.h, imageTransform, nextScale)) {
      resetDraft();
      setNotice("That proportional resolution is outside Capso's safe 16–16,384 px / 32 MP limit.");
      setNoticeIsError(true);
      return;
    }
    const output = imageScaleOutputSize(viewport.w, viewport.h, imageTransform, nextScale);
    dispatchEdit({ type: "resize", imageScale: nextScale });
    setResizeDraft({ width: String(output.width), height: String(output.height) });
    setNotice(`Output set to ${output.width} × ${output.height} px · aspect ratio locked.`);
    setNoticeIsError(false);
  }

  function resetImageResize() {
    if (imageScale === DEFAULT_IMAGE_SCALE) return;
    const output = imageScaleOutputSize(
      viewport.w,
      viewport.h,
      imageTransform,
      DEFAULT_IMAGE_SCALE,
    );
    dispatchEdit({ type: "resize", imageScale: DEFAULT_IMAGE_SCALE });
    setResizeDraft({ width: String(output.width), height: String(output.height) });
    setNotice(`Original output resolution restored at ${output.width} × ${output.height} px.`);
    setNoticeIsError(false);
  }

  function resetCrop() {
    if (!editState.crop) return;
    dispatchEdit({ type: "crop", crop: null });
    setSelected(null);
    setNotice("Crop reset to the protected original dimensions. Undo restores the cropped frame.");
    setNoticeIsError(false);
  }

  function navigateMoreMenu(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
    if (options.length === 0) return;
    event.preventDefault();
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? options.length - 1
        : (current + (event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1) + options.length) % options.length;
    options[next]?.focus();
  }

  async function startAnnotationDrag() {
    const canvas = canvasRef.current;
    if (!canvas || saving || dragging || copying || exporting || typing !== null) return;
    const actionKey = `drag:${capture.sessionId}`;
    if (!beginAnnotationAction(actionKey)) return;
    setDragging(true);
    setNoticeIsError(false);
    setNotice("Preparing a flattened copy · keep holding to drag…");
    repaint(false);
    let pngDataUrl: string;
    try {
      pngDataUrl = canvas.toDataURL("image/png");
    } catch (error) {
      repaint(true);
      setDragging(false);
      endAnnotationAction(actionKey);
      setNotice(`Could not prepare the annotation drag: ${String(error)}`);
      setNoticeIsError(true);
      return;
    }
    repaint(true);
    if (!nativeRuntime) {
      const bytes = Math.floor((pngDataUrl.length - pngDataUrl.indexOf(",") - 1) * 0.75);
      setDragging(false);
      endAnnotationAction(actionKey);
      setNotice(`Preview prepared a ${bytes.toLocaleString()} byte flattened drag copy.`);
      return;
    }
    try {
      await invoke<AnnotationDragStarted>("start_annotation_drag", {
        request: {
          path: capture.path,
          presentationId: capture.presentationId,
          sessionId: capture.sessionId,
          pngDataUrl,
          filename: suggestedCaptureFilename(),
          crop: editState.crop,
          imageTransform,
          imageScale,
        },
      });
      setNotice("Drag into Finder, Messages or any image-aware app.");
    } catch (error) {
      dragGesture.current.reset();
      setDragging(false);
      endAnnotationAction(actionKey);
      setNotice(`Could not drag the annotated copy: ${String(error)}`);
      setNoticeIsError(true);
    }
  }

  async function exportAnnotation() {
    const canvas = canvasRef.current;
    if (!canvas || saving || dragging || copying || exporting || typing !== null) return;
    const actionKey = `export:${capture.sessionId}`;
    if (!beginAnnotationAction(actionKey)) return;
    setExporting(true);
    setNoticeIsError(false);
    setNotice(nativeRuntime
      ? "Choose where to export this flattened copy…"
      : "Preparing a clean flattened export preview…");
    try {
      if (!nativeRuntime) {
        repaint(false);
        let pngDataUrl: string;
        try {
          pngDataUrl = canvas.toDataURL("image/png");
        } finally {
          repaint(true);
        }
        const bytes = Math.floor((pngDataUrl.length - pngDataUrl.indexOf(",") - 1) * 0.75);
        setNotice(`Preview exported a ${bytes.toLocaleString()} byte clean PNG copy · project unchanged.`);
        return;
      }

      const preferences = await invoke<OverlaySaveAsPreferences>("get_save_as_preferences");
      const destination = await chooseSaveDestination({
        title: "Export Annotated Image",
        defaultPath: suggestedCaptureFilename(new Date(), preferences),
        filters: saveAsFilters(preferences.format),
        canCreateDirectories: true,
      });
      if (!destination) {
        setNotice("Export cancelled · editable project remains unchanged.");
        return;
      }

      repaint(false);
      let pngDataUrl: string;
      try {
        pngDataUrl = canvas.toDataURL("image/png");
      } finally {
        repaint(true);
      }
      const result = await invoke<AnnotationExportResult>("export_annotation_copy", {
        request: {
          path: capture.path,
          presentationId: capture.presentationId,
          sessionId: capture.sessionId,
          pngDataUrl,
          destination,
          crop: editState.crop,
          imageTransform,
          imageScale,
        },
      });
      setNotice(result.format === "jpeg"
        ? `Exported ${destinationName(result.destination)} as JPEG · transparency uses white · project unchanged.`
        : `Exported ${destinationName(result.destination)} as PNG · project unchanged.`);
    } catch (error) {
      setNotice(`Could not export the annotated image: ${String(error)}`);
      setNoticeIsError(true);
    } finally {
      endAnnotationAction(actionKey);
      setExporting(false);
    }
  }

  async function copyAnnotation() {
    const canvas = canvasRef.current;
    if (!canvas || saving || dragging || copying || exporting || typing !== null) return;
    const actionKey = `copy:${capture.sessionId}`;
    if (!beginAnnotationAction(actionKey)) return;
    setCopying(true);
    setNoticeIsError(false);
    setNotice(nativeRuntime
      ? "Copying a clean flattened PNG…"
      : "Preparing a clean flattened copy preview…");
    try {
      repaint(false);
      let pngDataUrl: string;
      try {
        pngDataUrl = canvas.toDataURL("image/png");
      } finally {
        repaint(true);
      }
      if (!nativeRuntime) {
        const bytes = Math.floor((pngDataUrl.length - pngDataUrl.indexOf(",") - 1) * 0.75);
        setNotice(`Preview prepared a ${bytes.toLocaleString()} byte clean PNG copy · project unchanged.`);
        return;
      }

      const result = await invoke<AnnotationCopyResult>("copy_annotation_image", {
        request: {
          path: capture.path,
          presentationId: capture.presentationId,
          sessionId: capture.sessionId,
          pngDataUrl,
          crop: editState.crop,
          imageTransform,
          imageScale,
        },
      });
      setNotice(`Copied ${result.bytes.toLocaleString()} byte clean PNG · project unchanged.`);
    } catch (error) {
      setNotice(`Could not copy the annotated image: ${String(error)} Try Save & copy or Export…`);
      setNoticeIsError(true);
    } finally {
      endAnnotationAction(actionKey);
      setCopying(false);
    }
  }

  async function save() {
    const canvas = canvasRef.current;
    if (
      !canvas
      || saving
      || dragging
      || copying
      || exporting
      || typing !== null
      || (marks.length === 0
        && editState.crop === null
        && isDefaultImageTransform(imageTransform)
        && imageScale === DEFAULT_IMAGE_SCALE)
    ) return;
    const actionKey = `save:${capture.sessionId}`;
    if (!beginAnnotationAction(actionKey)) return;
    setSaving(true);
    setNoticeIsError(false);
    setNotice("Flattening annotation into the saved capture…");
    repaint(false);
    const toolsUsed = Array.from(new Set<Tool | "transform" | "resize">([
      ...marks.map(toolForMark),
      ...(editState.crop ? ["crop" as const] : []),
      ...(!isDefaultImageTransform(imageTransform) ? ["transform" as const] : []),
      ...(imageScale !== DEFAULT_IMAGE_SCALE ? ["resize" as const] : []),
    ]));
    try {
      const pngDataUrl = canvas.toDataURL("image/png");
      if (nativeRuntime) {
        await invoke<AnnotationSaveResult>("save_annotation_editor", {
          request: {
            path: capture.path,
            presentationId: capture.presentationId,
            sessionId: capture.sessionId,
            pngDataUrl,
            toolsUsed,
            redacted: redacts(marks),
            documentRevision: capture.documentRevision,
            crop: editState.crop,
            imageTransform,
            imageScale,
            marks,
          },
        });
      } else {
        const bytes = Math.floor((pngDataUrl.length - pngDataUrl.indexOf(",") - 1) * 0.75);
        setNotice(`Preview flattened (${bytes.toLocaleString()} bytes) · app save also copies.`);
      }
    } catch (error) {
      setNotice(String(error));
      setNoticeIsError(true);
    } finally {
      endAnnotationAction(actionKey);
      setSaving(false);
      repaint(true);
    }
  }

  const selectedMarkForGuidance = selected === null ? undefined : marks[selected];
  const guidance = selectedMarkForGuidance?.kind === "spotlight"
    ? "Drag corners to resize · Drag inside to move · Strength is baked into the PNG"
    : selectedMarkForGuidance?.kind === "blur_effect"
      ? (selectedMarkForGuidance.blurMode ?? DEFAULT_BLUR_MODE) === "secure"
        ? `Secure blur destroys detail · ${selectedMarkForGuidance.blurStrength ?? DEFAULT_BLUR_STRENGTH} intensity · Undo restores the editable mark`
        : `Smooth blur is visual only · ${selectedMarkForGuidance.blurStrength ?? DEFAULT_BLUR_STRENGTH} intensity · Never use it for secrets`
      : selectedMarkForGuidance?.kind === "highlighter" && selectedMarkForGuidance.smartWidth !== undefined
        ? `${Math.round(selectedMarkForGuidance.smartWidth)} px Smart row · Stroke control switches to manual`
      : selectedMarkForGuidance?.kind === "text"
        ? "Return/double-click edits · ⌘C/V copies · ⌘D duplicates · Delete"
        : selectedMarkForGuidance
          ? resizeHandles(selectedMarkForGuidance, viewport.w).length > 0
            ? "Handles resize · ⌘C/V copies · ⌘D/⌥-drag duplicates · Delete"
            : "Drag moves · ⌘C/V copies · ⌘D/⌥-drag duplicates · Delete"
          : tool === "box" || tool === "ellipse"
            ? `Drag to draw · Hold Shift for a perfect ${tool === "box" ? "square" : "circle"}`
          : tool === "blur"
            ? "Pixelate destroys detail before upload - it is baked into the PNG."
            : tool === "blur-effect"
              ? blurMode === "secure"
                ? "Secure blur destroys detail before upload · Choose Smooth only for visual softening"
                : "Smooth blur is visual only — never use it for secrets"
              : tool === "pencil"
                ? "Drag to sketch · Pointer samples are smoothed into one reversible mark"
                : tool === "highlighter"
                  ? "Smart snap · Hold ⌘ at drag start for free"
                  : tool === "eraser"
                    ? "Erase freehand ink · Shapes and original stay protected"
                  : tool === "spotlight"
                    ? "Drag one focus region · Everything outside is dimmed in the PNG"
                    : tool === "counter"
                      ? `Click to place ${nextCounterValue(marks, counterStart)} · Existing numbers stay fixed`
                    : tool === "crop"
                        ? "Drag a crop frame · Choose an aspect · Shift snaps to 1:1 · Undo restores"
                        : "Drag to draw · Shift locks movement · ⌥-drag duplicates · ⌘Z undo";
  const moreToolActive = MORE_TOOLS.includes(tool);
  const orientedViewport = imageTransformOutputSize(viewport.w || 1, viewport.h || 1, imageTransform);
  const orientedTypingPoint = typing
    ? imagePointToOutput(
        { x: typing.x - viewport.x, y: typing.y - viewport.y },
        viewport.w || 1,
        viewport.h || 1,
        imageTransform,
      )
    : null;

  return (
    <main className="annotation-shell">
      {/* Once, near the root — every CapsoGlyph below is a <use> of these. */}
      <CapsoGlyphDefs />
      <header className="annotation-toolbar">
        {/* titleBarStyle "Overlay" leaves no titlebar to grab. Only this
            non-interactive brand block drags, so the tool buttons keep working. */}
        <div
          className="annotation-brand"
          aria-label="Capso annotation editor"
          data-tauri-drag-region
        >
          <span aria-hidden="true" data-tauri-drag-region />
          <strong data-tauri-drag-region>Annotate</strong>
        </div>
        <div className="annotation-tools" role="toolbar" aria-label="Annotation tools">
          {PRIMARY_TOOLS.map((candidate) => (
            <button
              type="button"
              key={candidate}
              className="annotation-tool"
              aria-label={`${candidate} tool`}
              aria-pressed={tool === candidate}
              title={toolLabel(candidate)}
              onClick={() => chooseTool(candidate)}
            >
              <ToolIcon tool={candidate} />
              <span>{toolLabel(candidate)}</span>
            </button>
          ))}
          <div className="annotation-more" ref={moreRef}>
            <button
              ref={moreTriggerRef}
              type="button"
              className="annotation-tool annotation-more-trigger"
              aria-label={moreToolActive ? `More tools, ${toolLabel(tool)} selected` : "More annotation tools"}
              aria-controls="annotation-more-menu"
              aria-expanded={moreOpen}
              aria-haspopup="menu"
              aria-pressed={moreToolActive}
              title={moreToolActive ? `${toolLabel(tool)} selected · More tools` : "More tools"}
              onClick={() => setMoreOpen((open) => {
                const next = !open;
                if (next) requestAnimationFrame(() => moreFirstRef.current?.focus());
                return next;
              })}
            >
              <i className="annotation-more-dots" aria-hidden="true">•••</i>
              <span>{moreToolActive ? toolLabel(tool) : "More"}</span>
            </button>
            {moreOpen && (
              <div
                id="annotation-more-menu"
                className="annotation-more-menu"
                role="menu"
                aria-label="More annotation tools"
                onKeyDown={navigateMoreMenu}
              >
                {MORE_TOOLS.map((candidate, index) => (
                  <button
                    ref={index === 0 ? moreFirstRef : undefined}
                    type="button"
                    role="menuitemradio"
                    aria-checked={tool === candidate}
                    key={candidate}
                    onClick={() => chooseTool(candidate, true)}
                  >
                    <ToolIcon tool={candidate} />
                    <span>{toolLabel(candidate)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div
          className="annotation-colors"
          aria-label="Annotation colors"
          data-hidden={!styleHasColor}
        >
          {PALETTE.map((candidate) => (
            <button
              type="button"
              key={candidate}
              aria-label={`Use color ${candidate}`}
              aria-pressed={visibleColor === candidate}
              style={{ backgroundColor: candidate }}
              onClick={() => changeColor(candidate)}
            />
          ))}
          {customColors.slice(0, 2).map((candidate, index) => (
            <button
              className={index === 0
                ? "annotation-saved-color"
                : "annotation-saved-color annotation-saved-color-secondary"}
              type="button"
              key={candidate}
              aria-label={`Use saved custom color ${candidate}`}
              aria-pressed={visibleColor === candidate}
              style={{ backgroundColor: candidate }}
              onClick={() => changeColor(candidate)}
            />
          ))}
          <button
            className="annotation-custom-color-button"
            type="button"
            aria-label="Pick and save custom annotation color"
            aria-haspopup="dialog"
            title="Pick and save a custom color"
            onClick={(event) => openCustomColorPicker(event.currentTarget)}
          >
            +
          </button>
        </div>
        <div
          className="annotation-color-compact"
          data-hidden={!styleHasColor}
          title={`Color: ${COLOR_NAMES[PALETTE.indexOf(visibleColor as typeof PALETTE[number])] ?? "Custom"}`}
        >
          <span style={{ backgroundColor: visibleColor }} aria-hidden="true" />
          <select
            aria-label="Annotation color"
            value={visibleColor}
            disabled={!styleHasColor}
            onChange={(event) => {
              if (event.target.value === "__capso_custom_color__") {
                event.currentTarget.value = visibleColor;
                openCustomColorPicker(event.currentTarget);
              } else {
                changeColor(event.target.value);
              }
            }}
          >
            <optgroup label="Capso colors">
              {PALETTE.map((candidate, index) => (
                <option key={candidate} value={candidate}>{COLOR_NAMES[index]}</option>
              ))}
            </optgroup>
            {customColors.length > 0 && (
              <optgroup label="Saved custom colors">
                {customColors.map((candidate) => (
                  <option key={candidate} value={candidate}>{candidate.toUpperCase()}</option>
                ))}
              </optgroup>
            )}
            {!PALETTE.some((candidate) => candidate === visibleColor)
              && !customColors.includes(visibleColor)
              && <option value={visibleColor}>Current project color</option>}
            <option value="__capso_custom_color__">Custom…</option>
          </select>
        </div>
        <input
          ref={customColorInputRef}
          className="annotation-native-color-input"
          type="color"
          hidden
          tabIndex={-1}
          aria-label="Custom annotation color value"
          value={isAnnotationHexColor(visibleColor) ? visibleColor : DEFAULT_COLOR}
          onChange={(event) => chooseAndSaveCustomColor(event.target.value)}
        />
        <div
          className="annotation-stroke-picker"
          data-hidden={!styleHasStroke}
          data-weight={visibleStrokeWeight}
          title={`Stroke width: ${visibleStrokeWeight}`}
        >
          <span aria-hidden="true" />
          <select
            aria-label="Stroke width"
            value={visibleStrokeWeight}
            disabled={!styleHasStroke}
            onChange={(event) => changeStrokeWeight(event.target.value as StrokeWeight)}
          >
            {STROKE_WEIGHTS.map((weight) => (
              <option key={weight} value={weight}>{weight[0]!.toUpperCase() + weight.slice(1)}</option>
            ))}
          </select>
        </div>
        <div
          className="annotation-highlighter-opacity-picker"
          data-hidden={!styleHasHighlighter}
          data-opacity={visibleHighlighterOpacity}
          title={`Highlighter opacity: ${visibleHighlighterOpacity}`}
        >
          <span aria-hidden="true">{
            visibleHighlighterOpacity === "soft" ? "18" : visibleHighlighterOpacity === "strong" ? "45" : "30"
          }</span>
          <select
            aria-label="Highlighter opacity"
            value={visibleHighlighterOpacity}
            disabled={!styleHasHighlighter}
            onChange={(event) => changeHighlighterOpacity(event.target.value as HighlighterOpacity)}
          >
            {HIGHLIGHTER_OPACITIES.map((opacity) => (
              <option key={opacity} value={opacity}>{
                `${opacity[0]!.toUpperCase() + opacity.slice(1)} · ${opacity === "soft" ? 18 : opacity === "strong" ? 45 : 30}%`
              }</option>
            ))}
          </select>
        </div>
        <div
          className="annotation-arrow-picker"
          data-hidden={!styleHasArrow}
          data-style={visibleArrowStyle}
          title={`Arrow style: ${visibleArrowStyle}`}
        >
          <span aria-hidden="true">{
            visibleArrowStyle === "curved" ? "↝" : visibleArrowStyle === "double" ? "↔" : "→"
          }</span>
          <select
            aria-label="Arrow style"
            value={visibleArrowStyle}
            disabled={!styleHasArrow}
            onChange={(event) => changeArrowStyle(event.target.value as ArrowStyle)}
          >
            {ARROW_STYLES.map((style) => (
              <option key={style} value={style}>{
                style === "double" ? "Double headed" : style[0]!.toUpperCase() + style.slice(1)
              }</option>
            ))}
          </select>
        </div>
        <div
          className="annotation-shape-styles"
          aria-label="Shape style"
          data-hidden={!styleHasShape}
        >
          {(["outline", "filled"] as const).map((style) => (
            <button
              type="button"
              key={style}
              aria-label={`Use ${style} shape`}
              aria-pressed={visibleShapeStyle === style}
              title={style === "outline" ? "Outline shape" : "Filled shape with translucent ink"}
              onClick={() => changeShapeStyle(style)}
            >
              <span data-filled={style === "filled"} aria-hidden="true" />
              <em>{style === "outline" ? "Outline" : "Fill"}</em>
            </button>
          ))}
        </div>
        <div
          className="annotation-size-picker"
          data-hidden={!styleHasSize}
          data-kind={styleKind}
          title={`${styleKind === "text" ? "Text" : "Counter"} size: ${visibleSizePreset}`}
        >
          <span aria-hidden="true">{styleKind === "text" ? "A" : "1"}</span>
          <select
            aria-label={styleKind === "text" ? "Text size" : "Counter size"}
            value={visibleSizePreset}
            disabled={!styleHasSize}
            onChange={(event) => changeSizePreset(event.target.value as SizePreset)}
          >
            {SIZE_PRESETS.map((preset) => (
              <option key={preset} value={preset}>{preset[0]!.toUpperCase() + preset.slice(1)}</option>
            ))}
          </select>
        </div>
        <div
          className="annotation-text-style-picker"
          data-hidden={!styleHasText}
          data-style={visibleTextStyle}
          title={`Text style: ${visibleTextStyle}`}
        >
          <span aria-hidden="true">Aa</span>
          <select
            aria-label="Text style"
            value={visibleTextStyle}
            disabled={!styleHasText}
            onChange={(event) => changeTextStyle(event.target.value as TextStyle)}
          >
            {TEXT_STYLES.map((style) => (
              <option key={style} value={style}>{
                style.split("-").map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" ")
              }</option>
            ))}
          </select>
        </div>
        <div
          className="annotation-counter-style-picker"
          data-hidden={!styleHasCounter}
          data-style={visibleCounterStyle}
          title={`Counter style: ${visibleCounterStyle}`}
        >
          <span aria-hidden="true">{visibleCounterStyle === "filled" ? "●" : visibleCounterStyle === "outlined" ? "○" : "1"}</span>
          <select
            aria-label="Counter style"
            value={visibleCounterStyle}
            disabled={!styleHasCounter}
            onChange={(event) => changeCounterStyle(event.target.value as CounterStyle)}
          >
            {COUNTER_STYLES.map((style) => (
              <option key={style} value={style}>{
                style === "filled" ? "Filled circle" : style === "outlined" ? "Outline circle" : "Number only"
              }</option>
            ))}
          </select>
        </div>
        <label
          className="annotation-counter-start"
          data-hidden={!styleHasCounter}
          title="Starting number for the next counter sequence"
        >
          <span aria-hidden="true">#</span>
          <input
            aria-label="Counter starting number"
            type="number"
            inputMode="numeric"
            min={0}
            max={9999}
            step={1}
            value={counterStart}
            disabled={!styleHasCounter}
            onChange={(event) => {
              const parsed = Number(event.target.value);
              setCounterStart(Number.isFinite(parsed)
                ? Math.max(0, Math.min(9999, Math.trunc(parsed)))
                : 1);
            }}
          />
        </label>
        <button
          type="button"
          className="annotation-text-edit"
          data-hidden={selectedMark?.kind !== "text"}
          aria-label="Edit selected text"
          title="Edit text · Return or double-click"
          disabled={selectedMark?.kind !== "text" || saving || typing !== null}
          onClick={() => {
            if (selected !== null) beginTextEdit(selected);
          }}
        >
          <span aria-hidden="true">Edit</span>
        </button>
        <div
          className="annotation-spotlight-picker"
          data-hidden={styleKind !== "spotlight"}
          data-strength={visibleSpotlightStrength}
          title={`Spotlight strength: ${visibleSpotlightStrength}`}
        >
          <span aria-hidden="true" />
          <select
            aria-label="Spotlight strength"
            value={visibleSpotlightStrength}
            disabled={styleKind !== "spotlight"}
            onChange={(event) => changeSpotlightStrength(event.target.value as SpotlightStrength)}
          >
            {SPOTLIGHT_STRENGTHS.map((strength) => (
              <option key={strength} value={strength}>{strength[0]!.toUpperCase() + strength.slice(1)}</option>
            ))}
          </select>
        </div>
        <div
          className="annotation-spotlight-shape-picker"
          data-hidden={styleKind !== "spotlight"}
          data-shape={visibleSpotlightShape}
          title={`Spotlight shape: ${visibleSpotlightShape}`}
        >
          <span aria-hidden="true" />
          <select
            aria-label="Spotlight shape"
            value={visibleSpotlightShape}
            disabled={styleKind !== "spotlight"}
            onChange={(event) => changeSpotlightShape(event.target.value as SpotlightShape)}
          >
            {SPOTLIGHT_SHAPES.map((shape) => (
              <option key={shape} value={shape}>{
                shape === "rectangle" ? "Rectangle" : shape === "rounded" ? "Rounded rectangle" : "Ellipse"
              }</option>
            ))}
          </select>
        </div>
        <div
          className="annotation-blur-picker"
          data-hidden={!styleHasBlur}
          data-mode={visibleBlurMode}
          title={visibleBlurMode === "secure"
            ? "Secure blur destroys detail"
            : "Smooth blur is visual only"}
        >
          <span aria-hidden="true">{visibleBlurMode === "secure" ? "S" : "~"}</span>
          <select
            aria-label="Blur mode"
            value={visibleBlurMode}
            disabled={!styleHasBlur}
            onChange={(event) => changeBlurMode(event.target.value as BlurMode)}
          >
            <option value="secure">Secure blur</option>
            <option value="smooth">Smooth blur · visual only</option>
          </select>
        </div>
        <div
          className="annotation-blur-strength-picker"
          data-hidden={!styleHasBlur}
          data-strength={visibleBlurStrength}
          title={`Blur intensity: ${visibleBlurStrength}`}
        >
          <span aria-hidden="true">{visibleBlurStrength === "soft" ? "1" : visibleBlurStrength === "strong" ? "3" : "2"}</span>
          <select
            aria-label="Blur intensity"
            value={visibleBlurStrength}
            disabled={!styleHasBlur}
            onChange={(event) => changeBlurStrength(event.target.value as BlurStrength)}
          >
            {BLUR_STRENGTHS.map((strength) => (
              <option key={strength} value={strength}>{strength[0]!.toUpperCase() + strength.slice(1)}</option>
            ))}
          </select>
        </div>
        <div
          className="annotation-crop-aspect-picker"
          data-hidden={tool !== "crop"}
          data-aspect={cropAspect}
          title={`Crop aspect: ${cropAspect === "square" ? "1:1" : cropAspect}`}
        >
          <span aria-hidden="true">{cropAspect === "free" ? "↔" : cropAspect === "square" ? "1" : cropAspect}</span>
          <select
            aria-label="Crop aspect ratio"
            value={cropAspect}
            disabled={tool !== "crop"}
            onChange={(event) => setCropAspect(event.target.value as CropAspectChoice)}
          >
            <option value="free">Free</option>
            <option value="square">1:1</option>
            <option value="4:3">4:3</option>
            <option value="5:4">5:4</option>
            <option value="16:9">16:9</option>
            <option value="9:16">9:16</option>
          </select>
        </div>
        <button
          type="button"
          className="annotation-crop-reset"
          data-hidden={tool !== "crop" || editState.crop === null}
          aria-label="Reset crop to protected original"
          title="Reset to original dimensions"
          disabled={tool !== "crop" || editState.crop === null || saving}
          onClick={resetCrop}
        >
          Reset crop
        </button>
        <div
          className="annotation-layer-picker"
          data-hidden={!canReorderSelection}
          title="Layer order"
        >
          <span aria-hidden="true" />
          <select
            aria-label="Layer order"
            value=""
            disabled={!canReorderSelection}
            onChange={(event) => {
              if (event.target.value) reorderSelected(event.target.value as LayerAction);
            }}
          >
            <option value="" disabled>Layer order</option>
            <option value="back" disabled={selectedLayerPosition === 0}>Send to back</option>
            <option value="backward" disabled={selectedLayerPosition === 0}>Send backward</option>
            <option value="forward" disabled={selectedLayerPosition === foregroundIndices.length - 1}>Bring forward</option>
            <option value="front" disabled={selectedLayerPosition === foregroundIndices.length - 1}>Bring to front</option>
          </select>
        </div>
        <div
          className="annotation-transform-picker"
          data-transformed={!isDefaultImageTransform(imageTransform)}
          title={`Image orientation: ${imageTransformLabel(imageTransform)}`}
        >
          <span aria-hidden="true">↻</span>
          <select
            aria-label="Image transform"
            value=""
            disabled={saving || typing !== null}
            onChange={(event) => {
              if (event.target.value) applyImageTransform(event.target.value as ImageTransformAction);
            }}
          >
            <option value="" disabled>{imageTransformLabel(imageTransform)}</option>
            <option value="rotate_right">Rotate right 90°</option>
            <option value="rotate_left">Rotate left 90°</option>
            <option value="flip_horizontal">Flip horizontal</option>
            <option value="flip_vertical">Flip vertical</option>
            <option value="reset" disabled={isDefaultImageTransform(imageTransform)}>Reset orientation</option>
          </select>
        </div>
        <div className="annotation-resize" ref={resizeRef}>
          <button
            type="button"
            className="annotation-resize-trigger"
            aria-label="Resize output resolution"
            aria-expanded={resizeOpen}
            aria-controls="annotation-resize-panel"
            title={`Output resolution: ${resizedOutput.width} × ${resizedOutput.height} px`}
            disabled={saving || typing !== null || viewport.w <= 0 || viewport.h <= 0}
            onClick={() => setResizeOpen((open) => !open)}
          >
            <span aria-hidden="true">↔</span>
          </button>
          {resizeOpen && (
            <div
              id="annotation-resize-panel"
              className="annotation-resize-panel"
              role="dialog"
              aria-label="Resize output resolution"
            >
              <strong>Output resolution</strong>
              <p>Aspect ratio locked · protected original unchanged</p>
              <div>
                <label>
                  <span>Width</span>
                  <input
                    aria-label="Output width"
                    type="number"
                    inputMode="numeric"
                    value={resizeDraft.width}
                    onChange={(event) => setResizeDraft((draft) => ({ ...draft, width: event.target.value }))}
                    onBlur={() => commitImageResize("width")}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                  />
                </label>
                <span aria-hidden="true">×</span>
                <label>
                  <span>Height</span>
                  <input
                    aria-label="Output height"
                    type="number"
                    inputMode="numeric"
                    value={resizeDraft.height}
                    onChange={(event) => setResizeDraft((draft) => ({ ...draft, height: event.target.value }))}
                    onBlur={() => commitImageResize("height")}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                  />
                </label>
              </div>
              <button
                type="button"
                disabled={imageScale === DEFAULT_IMAGE_SCALE}
                onClick={resetImageResize}
              >Reset resolution</button>
            </div>
          )}
        </div>
        <span className="annotation-spacer" />
        <button
          type="button"
          className="annotation-icon-button"
          aria-label="Undo last annotation"
          title="Undo ⌘Z"
          disabled={editState.undo.length === 0 || saving || dragging || copying || exporting || typing !== null}
          onClick={undo}
        ><UndoIcon /></button>
        <button
          type="button"
          className="annotation-icon-button"
          aria-label="Redo last annotation"
          title="Redo ⌘⇧Z"
          disabled={editState.redo.length === 0 || saving || dragging || copying || exporting || typing !== null}
          onClick={redo}
        ><RedoIcon /></button>
        <button
          type="button"
          className="annotation-cancel"
          aria-label="Cancel annotation"
          disabled={saving || dragging || copying || exporting}
          onClick={() => void cancel()}
        >
          <span className="annotation-cancel-wide">Cancel</span>
          <span className="annotation-cancel-compact" aria-hidden="true">×</span>
        </button>
        <button
          type="button"
          className="annotation-save"
          disabled={saving
            || dragging
            || copying
            || exporting
            || (marks.length === 0
              && editState.crop === null
              && isDefaultImageTransform(imageTransform)
              && imageScale === DEFAULT_IMAGE_SCALE)
            || typing !== null}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : (
            <>
              <span className="annotation-save-wide">Save &amp; copy</span>
              <span className="annotation-save-compact">Save</span>
            </>
          )}
        </button>
      </header>

      <section ref={workspaceRef} className="annotation-workspace" aria-label="Capture canvas">
        <div className="annotation-pan-surface">
        <div
          className="annotation-canvas-frame"
          data-zoom-ready={displayedCanvas !== null}
          style={displayedCanvas ? {
            width: `${displayedCanvas.width}px`,
            height: `${displayedCanvas.height}px`,
          } : undefined}
        >
          <canvas
            ref={canvasRef}
            data-tool={tool}
            tabIndex={0}
            aria-label="Screenshot being annotated"
            onPointerDown={start}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={cancelPointer}
            onDoubleClick={editTextAt}
          />
          {typing && (
            <input
              autoFocus
              value={typing.value}
              placeholder={typing.editingIndex === undefined ? "Type label, then Return" : "Edit label, then Return"}
              aria-label="Annotation label"
              style={{
                left: `clamp(0px, ${((orientedTypingPoint?.x ?? 0) / orientedViewport.width) * 100}%, calc(100% - 11.5rem))`,
                top: `clamp(0px, ${((orientedTypingPoint?.y ?? 0) / orientedViewport.height) * 100}%, calc(100% - 2.15rem))`,
              }}
              onChange={(event) => setTyping({ ...typing, value: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.stopPropagation();
                  const editingExisting = typing.editingIndex !== undefined;
                  commitText();
                  if (editingExisting) {
                    requestAnimationFrame(() => canvasRef.current?.focus({ preventScroll: true }));
                  }
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  const editingExisting = typing.editingIndex !== undefined;
                  setTyping(null);
                  setNotice(editingExisting
                    ? "Text edit cancelled. The original label and style are unchanged."
                    : "Text entry cancelled. No empty annotation was added.");
                  setNoticeIsError(false);
                  if (editingExisting) {
                    requestAnimationFrame(() => canvasRef.current?.focus({ preventScroll: true }));
                  }
                }
              }}
            />
          )}
        </div>
        </div>
      </section>

      <div className="annotation-delivery-actions" aria-label="Annotation delivery actions">
        <button
          type="button"
          className="annotation-copy"
          aria-label="Copy annotated image"
          title="Copy a flattened PNG without saving or closing the project"
          disabled={saving || dragging || copying || exporting || typing !== null || size === null}
          onClick={() => void copyAnnotation()}
        >
          {copying ? "Copying…" : "Copy"}
        </button>
        <button
          type="button"
          className="annotation-export"
          aria-label="Export annotated image"
          title="Export a flattened PNG or JPEG copy without saving the project"
          disabled={saving || dragging || copying || exporting || typing !== null || size === null}
          onClick={() => void exportAnnotation()}
        >
          {exporting ? "Exporting…" : "Export…"}
        </button>
        <button
          type="button"
          className="annotation-drag-out"
          aria-label="Drag annotated image"
          title="Drag a flattened PNG copy without saving"
          data-dragging={dragging}
          disabled={saving || dragging || copying || exporting || typing !== null || size === null}
          onPointerDown={(event) => {
            if (event.button !== 0 || !event.isPrimary) return;
            dragMovedRef.current = false;
            dragGesture.current.begin(event.pointerId, event.clientX, event.clientY);
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!dragGesture.current.move(event.pointerId, event.clientX, event.clientY)) return;
            dragMovedRef.current = true;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            void startAnnotationDrag();
          }}
          onPointerUp={(event) => dragGesture.current.end(event.pointerId)}
          onPointerCancel={(event) => dragGesture.current.end(event.pointerId)}
          onClick={() => {
            if (dragMovedRef.current) {
              dragMovedRef.current = false;
              return;
            }
            if (!nativeRuntime) {
              void startAnnotationDrag();
              return;
            }
            setNotice("Drag this button into another app to export a flattened PNG copy.");
            setNoticeIsError(false);
          }}
        >
          <span aria-hidden="true">⠿</span>
          <strong>{dragging ? "Dragging…" : "Drag me"}</strong>
        </button>
      </div>

      <div className="annotation-zoom-controls" role="group" aria-label="Canvas zoom">
        <button
          type="button"
          aria-label="Zoom out canvas"
          title="Zoom out ⌘−"
          disabled={canvasZoom === CANVAS_ZOOM_STEPS[0]}
          onClick={() => changeCanvasZoom("out")}
        >−</button>
        <button
          type="button"
          className="annotation-zoom-value"
          aria-label="Reset canvas zoom to fit"
          title="Fit canvas ⌘0"
          disabled={canvasZoom === 1}
          onClick={resetCanvasZoom}
        >{canvasZoom === 1 ? "Fit" : `${Math.round(canvasZoom * 100)}%`}</button>
        <button
          type="button"
          aria-label="Zoom in canvas"
          title="Zoom in ⌘+"
          disabled={canvasZoom === CANVAS_ZOOM_STEPS.at(-1)}
          onClick={() => changeCanvasZoom("in")}
        >+</button>
      </div>

      <footer className="annotation-status" data-error={noticeIsError}>
        <span>{notice}</span>
        <span>{guidance}</span>
      </footer>
    </main>
  );
}

export default function AnnotationEditor() {
  const nativeRuntime = useMemo(isTauriRuntime, []);
  const [capture, setCapture] = useState<AnnotationCapture | null>(
    nativeRuntime ? null : PREVIEW_CAPTURE,
  );

  useEffect(() => {
    if (!nativeRuntime) return;
    let disposed = false;
    let receivedCaptureEvent = false;
    let unlisten: UnlistenFn | undefined;
    void (async () => {
      unlisten = await listen<AnnotationCapture>("annotation-capture", (event) => {
        if (!disposed) {
          receivedCaptureEvent = true;
          setCapture(event.payload);
        }
      });
      const current = await invoke<AnnotationCapture | null>("get_annotation_capture");
      if (!disposed && current && !receivedCaptureEvent) setCapture(current);
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [nativeRuntime]);

  if (!capture) {
    return <main className="annotation-loading">Preparing annotation editor…</main>;
  }
  const source = nativeRuntime
    ? `${convertFileSrc(capture.sourcePath)}?session=${capture.sessionId}&revision=${capture.documentRevision}`
    : PREVIEW_IMAGE;
  return <Editor key={capture.sessionId} capture={capture} source={source} nativeRuntime={nativeRuntime} />;
}
