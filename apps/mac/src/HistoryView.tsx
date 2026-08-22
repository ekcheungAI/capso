import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { color, intent } from "@capso/shared/tokens";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createLatestRequestGate } from "./async-control";
import { captureProjectList, type CaptureProject } from "./overlay-projects";
import {
  captureSizeLabel,
  captureTimeLabel,
  canCombineSelection,
  filterHistory,
  historyCaptureKindLabel,
  historyCardClickAction,
  historyLibraryMirrorPresentation,
  historyProjectLabel,
  historyProjectOptions,
  historySyncPresentation,
  historyMonthOptions,
  reorderCombineSelection,
  removeHistoryPreview,
  restoreHistoryPreview,
  selectFrameCapture,
  toggleCombineSelection,
  type AnnotationProjectSyncStatus,
  type HistorySnapshot,
  type HistoryCaptureFilter,
  type HistoryProjectFilter,
  type LocalHistoryCapture,
} from "./history-view";

type CombineLayout = "horizontal" | "vertical" | "grid";
type CaptureSyncSnapshot = {
  summary: { remotePending: number };
  warning: string | null;
};
type CompositionMode = "combine" | "frame" | null;
type FrameBackground = "canvas" | "ink" | "blue" | "custom";
type FramePadding = 24 | 48 | 96 | 144;
type FrameAlignment =
  | "top_left" | "top" | "top_right"
  | "left" | "center" | "right"
  | "bottom_left" | "bottom" | "bottom_right";
type FrameAspect = "auto" | "square" | "portrait" | "story" | "landscape";

type FrameStyle = {
  padding: FramePadding;
  background: FrameBackground;
  customBackground: string;
  alignment: FrameAlignment;
  aspect: FrameAspect;
  autoBalance: boolean;
};

type CombineHistoryResult = {
  width: number;
  height: number;
  bytes: number;
  capture: { status: "captured" | "cancelled" };
};

type OcrResult = {
  captureId: string;
  sessionId: number;
  text: string;
  lineCount: number;
  truncated: boolean;
  engine: "apple_vision_on_device";
  links: string[];
};

type SelectedOcrResult = {
  sourceName: string;
  sourceBytes: number;
  result: OcrResult;
};

type OcrSourceKind = "history" | "file" | "screen";

type HistoryRemovalUndo = {
  ids: string[];
  captures: LocalHistoryCapture[];
  cleared: boolean;
};

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

const PREVIEW_PROJECTS: CaptureProject[] = [
  { id: "018f22c4-cada-7c6b-9d5b-fc35f7f92276", name: "Launch research" },
  { id: "018f22c4-cada-7c6b-9d5b-fc35f7f92277", name: "Client clips" },
];

function previewHistory(): HistorySnapshot {
  const now = Date.now();
  const offsets = [8, 26, 75, 190, 480, 1_440, 4_200, 46_000, 68_000];
  return {
    captures: offsets.map((minutes, index) => ({
      id: `018f22c4-cada-7c6b-9d5b-fc35f7f9${String(2300 + index).padStart(4, "0")}`,
      path: "",
      capturedAtMs: now - minutes * 60_000,
      bytes: 218_000 + index * 146_000,
      source: (["region", "window", "fullscreen", "created", "browser", "recovered"] as const)[index % 6],
      projectId: index < 3 ? PREVIEW_PROJECTS[index % PREVIEW_PROJECTS.length].id : undefined,
      annotationRevision: index < 3 ? index + 1 : undefined,
    })),
    total: offsets.length,
    removed: 0,
    truncated: false,
  };
}

function previewProjectSync(): AnnotationProjectSyncStatus {
  const captures = previewHistory().captures;
  return {
    summary: { pending: 0, uploading: 0, failed: 1, conflicts: 1, synced: 1, total: 3 },
    warning: null,
    entries: [
      {
        captureId: captures[0].id,
        documentRevision: 1,
        cloudRevision: 1,
        status: "synced",
        lastError: null,
      },
      {
        captureId: captures[1].id,
        documentRevision: 2,
        cloudRevision: 4,
        status: "conflict",
        lastError: "Another Mac saved cloud revision 4.",
      },
      {
        captureId: captures[2].id,
        documentRevision: 3,
        cloudRevision: 0,
        status: "failed",
        lastError: "The protected original needs attention before sync.",
      },
    ],
  };
}

export default function HistoryView() {
  const nativeRuntime = useMemo(isTauriRuntime, []);
  const previewOcrMode = useMemo(
    () => !nativeRuntime ? new URLSearchParams(window.location.search).get("mode") : null,
    [nativeRuntime],
  );
  const [snapshot, setSnapshot] = useState<HistorySnapshot | null>(() =>
    nativeRuntime ? null : previewHistory(),
  );
  const [projectSync, setProjectSync] = useState<AnnotationProjectSyncStatus | null>(() =>
    nativeRuntime ? null : previewProjectSync(),
  );
  const [projects, setProjects] = useState<CaptureProject[]>(() =>
    nativeRuntime ? [] : PREVIEW_PROJECTS,
  );
  const [projectWarning, setProjectWarning] = useState<string | null>(null);
  const [syncWarning, setSyncWarning] = useState<string | null>(null);
  const [captureSync, setCaptureSync] = useState<CaptureSyncSnapshot | null>(null);
  const [month, setMonth] = useState("all");
  const [captureType, setCaptureType] = useState<HistoryCaptureFilter>("all");
  const [project, setProject] = useState<HistoryProjectFilter>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const actionInFlight = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("Choose a capture to reopen Quick Access.");
  const [removalUndo, setRemovalUndo] = useState<HistoryRemovalUndo | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [compositionMode, setCompositionMode] = useState<CompositionMode>(null);
  const [combineSelection, setCombineSelection] = useState<string[]>([]);
  const [combineLayout, setCombineLayout] = useState<CombineLayout>("horizontal");
  const [draggingCapture, setDraggingCapture] = useState<string | null>(null);
  const [frameSelection, setFrameSelection] = useState<string[]>([]);
  const [frameStyle, setFrameStyle] = useState<FrameStyle>({
    padding: 48,
    background: "canvas",
    customBackground: intent.reference.toUpperCase(),
    alignment: "center",
    aspect: "portrait",
    autoBalance: true,
  });
  const pendingCardOpen = useRef<number | null>(null);
  const historyLoadGate = useRef(createLatestRequestGate());
  const [ocrCapture, setOcrCapture] = useState<LocalHistoryCapture | null>(() =>
    previewOcrMode?.startsWith("ocr") ? previewHistory().captures[0] : null,
  );
  const [ocrResult, setOcrResult] = useState<OcrResult | null>(() =>
    previewOcrMode === "ocr" || previewOcrMode === "ocr-links"
      ? {
          captureId: previewHistory().captures[0].id,
          sessionId: 1,
          text: previewOcrMode === "ocr-links"
            ? "Capso private OCR\nDocs: https://capso.app/privacy\nReference: http://example.com/capture?id=42"
            : "CAPSO ON-DEVICE OCR\nCapture first. Organise later.\n繁體中文同英文都會留喺呢部 Mac 處理。",
          lineCount: 3,
          truncated: false,
          engine: "apple_vision_on_device",
          links: previewOcrMode === "ocr-links"
            ? ["https://capso.app/privacy", "http://example.com/capture?id=42"]
            : [],
        }
      : null,
  );
  const [ocrSourceName, setOcrSourceName] = useState<string | null>(() =>
    previewOcrMode?.startsWith("ocr") ? "Saved Capso capture" : null,
  );
  const [ocrSourceKind, setOcrSourceKind] = useState<OcrSourceKind | null>(() =>
    previewOcrMode?.startsWith("ocr") ? "history" : null,
  );
  const ocrCopyBusy = busy?.startsWith("ocr-copy") ?? false;

  useEffect(() => {
    if (!ocrCapture) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !ocrCopyBusy) {
        setOcrCapture(null);
        setOcrResult(null);
        setOcrSourceName(null);
        setOcrSourceKind(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ocrCapture, ocrCopyBusy]);

  useEffect(() => () => {
    if (pendingCardOpen.current !== null) {
      window.clearTimeout(pendingCardOpen.current);
    }
  }, []);

  const load = useCallback(async () => {
    const isLatest = historyLoadGate.current.begin();
    if (!nativeRuntime) {
      if (!isLatest()) return;
      setSnapshot(previewHistory());
      setProjectSync(previewProjectSync());
      setProjects(PREVIEW_PROJECTS);
      setProjectWarning(null);
      setCaptureSync({ summary: { remotePending: 0 }, warning: null });
      setSyncWarning(null);
      setError(null);
      return;
    }
    try {
      const next = await invoke<HistorySnapshot>("get_local_history");
      if (!isLatest()) return;
      setSnapshot(next);
      setError(null);
      try {
        const sync = await invoke<AnnotationProjectSyncStatus>("get_annotation_project_sync_status");
        if (!isLatest()) return;
        setProjectSync(sync);
        setSyncWarning(sync.warning);
      } catch (reason) {
        if (!isLatest()) return;
        setProjectSync(null);
        setSyncWarning(`Editable project sync status is unavailable: ${String(reason)}`);
      }
      try {
        const sync = await invoke<CaptureSyncSnapshot>("get_sync_status");
        if (!isLatest()) return;
        setCaptureSync(sync);
      } catch {
        if (!isLatest()) return;
        setCaptureSync(null);
      }
      try {
        const value = await invoke<unknown>("get_capture_projects");
        if (!isLatest()) return;
        const nextProjects = captureProjectList(value);
        if (!nextProjects) throw new Error("invalid project list");
        setProjects(nextProjects);
        setProjectWarning(null);
      } catch {
        if (!isLatest()) return;
        setProjectWarning("Project names are unavailable. Assignments remain safe; retry when connected.");
      }
    } catch (reason) {
      if (!isLatest()) return;
      setError(String(reason));
    }
  }, [nativeRuntime]);

  useEffect(() => {
    void load();
    if (!nativeRuntime) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void Promise.all([
      listen("queue-status-changed", () => {
        if (!disposed) void load();
      }),
      listen("annotation-project-saved", () => {
        if (!disposed) void load();
      }),
      listen("annotation-project-sync-changed", () => {
        if (!disposed) void load();
      }),
      listen("history-changed", () => {
        if (!disposed) void load();
      }),
      listen("sync-status-changed", () => {
        if (!disposed) void load();
      }),
    ]).then((stops) => {
      if (disposed) stops.forEach((stop) => stop());
      else unlisten = () => stops.forEach((stop) => stop());
    });
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      disposed = true;
      historyLoadGate.current.invalidate();
      unlisten?.();
      window.removeEventListener("focus", onFocus);
    };
  }, [load, nativeRuntime]);

  const months = useMemo(() => historyMonthOptions(snapshot?.captures ?? []), [snapshot]);
  const projectOptions = useMemo(
    () => historyProjectOptions(snapshot?.captures ?? [], projects),
    [projects, snapshot],
  );
  const activeProjectIds = useMemo(() => projects.map((candidate) => candidate.id), [projects]);
  const captures = useMemo(
    () => filterHistory(snapshot?.captures ?? [], month, captureType, project, activeProjectIds),
    [activeProjectIds, captureType, month, project, snapshot],
  );
  const projectSyncByCapture = useMemo(
    () => new Map(projectSync?.entries.map((entry) => [entry.captureId, entry]) ?? []),
    [projectSync],
  );
  const libraryMirror = useMemo(
    () => historyLibraryMirrorPresentation(
      captureSync?.summary.remotePending ?? 0,
      captureSync?.warning ?? null,
    ),
    [captureSync],
  );
  const selectedCaptures = useMemo(() => combineSelection.flatMap((id) => {
    const capture = snapshot?.captures.find((candidate) => candidate.id === id);
    return capture ? [capture] : [];
  }), [combineSelection, snapshot]);
  const framedCapture = useMemo(() => {
    const id = frameSelection[0];
    return id ? snapshot?.captures.find((capture) => capture.id === id) ?? null : null;
  }, [frameSelection, snapshot]);
  const customFrameColourIsValid = /^#[0-9a-f]{6}$/i.test(frameStyle.customBackground);

  function beginHistoryAction(key: string) {
    if (actionInFlight.current !== null) return false;
    actionInFlight.current = key;
    setBusy(key);
    setError(null);
    return true;
  }

  function endHistoryAction(key: string) {
    if (actionInFlight.current !== key) return;
    actionInFlight.current = null;
    setBusy(null);
  }

  function cancelPendingCardOpen() {
    if (pendingCardOpen.current === null) return;
    window.clearTimeout(pendingCardOpen.current);
    pendingCardOpen.current = null;
  }

  function stopComposing() {
    cancelPendingCardOpen();
    setCompositionMode(null);
    setCombineSelection([]);
    setFrameSelection([]);
    setDraggingCapture(null);
    setNotice("Choose a capture to reopen Quick Access.");
  }

  function startComposing(mode: Exclude<CompositionMode, null>) {
    if (actionInFlight.current !== null) return;
    cancelPendingCardOpen();
    if (compositionMode === mode) {
      stopComposing();
      return;
    }
    setCompositionMode(mode);
    setCombineSelection([]);
    setFrameSelection([]);
    setDraggingCapture(null);
    setNotice(mode === "combine"
      ? "Select two to eight captures. Selection order becomes image order."
      : "Select one capture, then choose its delivery frame.");
  }

  function moveCombinedCapture(id: string, direction: -1 | 1) {
    const index = combineSelection.indexOf(id);
    const target = combineSelection[index + direction];
    if (index < 0 || !target) return;
    setCombineSelection(reorderCombineSelection(combineSelection, id, target));
  }

  async function combine() {
    const actionKey = "combine";
    if (!canCombineSelection(combineSelection) || !beginHistoryAction(actionKey)) return;
    try {
      let result: CombineHistoryResult;
      if (nativeRuntime) {
        result = await invoke<CombineHistoryResult>("combine_history_captures", {
          ids: combineSelection,
          layout: combineLayout,
        });
      } else {
        result = {
          width: combineLayout === "vertical" ? 1280 : 2576,
          height: combineLayout === "horizontal" ? 760 : 1536,
          bytes: 1_842_000,
          capture: { status: "captured" },
        };
      }
      setNotice(
        `Created a ${result.width} × ${result.height} full-resolution PNG (${captureSizeLabel(result.bytes)}). The source captures were unchanged.`,
      );
      setCompositionMode(null);
      setCombineSelection([]);
      setDraggingCapture(null);
      await load();
    } catch (reason) {
      setError(String(reason));
    } finally {
      endHistoryAction(actionKey);
    }
  }

  async function frameForSocial() {
    const actionKey = "frame";
    if (!framedCapture
      || (frameStyle.background === "custom" && !customFrameColourIsValid)
      || !beginHistoryAction(actionKey)) return;
    try {
      let result: CombineHistoryResult;
      if (nativeRuntime) {
        result = await invoke<CombineHistoryResult>("frame_history_capture", {
          id: framedCapture.id,
          style: frameStyle,
        });
      } else {
        const previewDimensions: Record<FrameAspect, [number, number]> = {
          auto: [1536, 960],
          square: [1536, 1536],
          portrait: [1536, 1920],
          story: [1080, 1920],
          landscape: [1920, 1080],
        };
        const [width, height] = previewDimensions[frameStyle.aspect];
        result = { width, height, bytes: 1_624_000, capture: { status: "captured" } };
      }
      setNotice(
        `Created a ${result.width} × ${result.height} social-ready PNG (${captureSizeLabel(result.bytes)}). The source capture was unchanged.`,
      );
      setCompositionMode(null);
      setFrameSelection([]);
      await load();
    } catch (reason) {
      setError(String(reason));
    } finally {
      endHistoryAction(actionKey);
    }
  }

  async function restore(capture: LocalHistoryCapture) {
    const actionKey = capture.id;
    if (!beginHistoryAction(actionKey)) return;
    try {
      if (nativeRuntime) {
        await invoke("restore_history_capture", { id: capture.id });
      }
      setNotice("Opened in Quick Access — copy or save it there.");
    } catch (reason) {
      setError(String(reason));
    } finally {
      endHistoryAction(actionKey);
    }
  }

  async function removeFromHistory(capture: LocalHistoryCapture) {
    const actionKey = `remove:${capture.id}`;
    if (!beginHistoryAction(actionKey)) return;
    try {
      const ids = nativeRuntime
        ? await invoke<string[]>("remove_history_captures", { ids: [capture.id] })
        : [capture.id];
      if (ids.length === 0) {
        setNotice("That capture was already removed from History.");
        return;
      }
      setRemovalUndo({ ids, captures: [capture], cleared: false });
      setNotice("Removed from History. Files stay safe on this Mac.");
      if (nativeRuntime) await load();
      else setSnapshot((current) => current ? removeHistoryPreview(current, ids) : current);
    } catch (reason) {
      setError(String(reason));
    } finally {
      endHistoryAction(actionKey);
    }
  }

  async function clearHistory() {
    const actionKey = "clear-history";
    if (!snapshot || snapshot.total === 0 || !beginHistoryAction(actionKey)) return;
    try {
      const ids = nativeRuntime
        ? await invoke<string[]>("clear_capture_history")
        : snapshot.captures.map((capture) => capture.id);
      const idsSet = new Set(ids);
      setRemovalUndo({
        ids,
        captures: snapshot.captures.filter((capture) => idsSet.has(capture.id)),
        cleared: true,
      });
      setConfirmClear(false);
      setCompositionMode(null);
      setCombineSelection([]);
      setFrameSelection([]);
      setNotice(`Cleared ${ids.length} ${ids.length === 1 ? "capture" : "captures"} from History. Files stay safe on this Mac.`);
      if (nativeRuntime) await load();
      else setSnapshot((current) => current ? removeHistoryPreview(current, ids) : current);
    } catch (reason) {
      setError(String(reason));
    } finally {
      endHistoryAction(actionKey);
    }
  }

  async function undoHistoryRemoval() {
    const actionKey = "undo-history";
    if (!removalUndo || !beginHistoryAction(actionKey)) return;
    const undo = removalUndo;
    try {
      if (nativeRuntime) {
        await invoke("restore_history_captures", { ids: undo.ids });
        await load();
      } else {
        setSnapshot((current) => current
          ? restoreHistoryPreview(current, undo.captures)
          : current);
      }
      setRemovalUndo(null);
      setNotice(undo.cleared
        ? "History restored. Every capture from that clear action is visible again."
        : "Capture restored to History.");
    } catch (reason) {
      setError(String(reason));
    } finally {
      endHistoryAction(actionKey);
    }
  }

  async function annotate(capture: LocalHistoryCapture) {
    cancelPendingCardOpen();
    const actionKey = capture.id;
    if (!beginHistoryAction(actionKey)) return;
    try {
      if (nativeRuntime) {
        await invoke("open_history_annotation_editor", { id: capture.id });
      }
      setNotice(capture.annotationRevision
        ? `Opened editable annotation revision ${capture.annotationRevision}.`
        : "Opened this flattened capture as a new editable project. Nothing changes until Save.");
    } catch (reason) {
      setError(String(reason));
    } finally {
      endHistoryAction(actionKey);
    }
  }

  async function recoverProject(
    capture: LocalHistoryCapture,
    action: "retry" | "keep_local",
  ) {
    const actionKey = capture.id;
    if (!beginHistoryAction(actionKey)) return;
    try {
      if (nativeRuntime) {
        const command = action === "retry"
          ? "retry_annotation_project_sync"
          : "keep_local_annotation_project";
        const next = await invoke<AnnotationProjectSyncStatus>(command, { id: capture.id });
        setProjectSync(next);
      }
      setNotice(action === "retry"
        ? "Retry queued. The editable files remain safe on this Mac."
        : "This Mac version is queued as the next cloud revision. The other Mac version remains in cloud history.");
    } catch (reason) {
      setError(String(reason));
    } finally {
      endHistoryAction(actionKey);
    }
  }

  async function openWebLibrary() {
    if (!nativeRuntime) {
      setNotice("The installed app opens your private web library here.");
      return;
    }
    const actionKey = "open-web-library";
    if (!beginHistoryAction(actionKey)) return;
    try {
      await invoke("open_web_library");
    } catch (reason) {
      setError(String(reason));
    } finally {
      endHistoryAction(actionKey);
    }
  }

  async function extractText(capture: LocalHistoryCapture) {
    const actionKey = `ocr:${capture.id}`;
    if (!beginHistoryAction(actionKey)) return;
    setOcrCapture(capture);
    setOcrResult(null);
    setOcrSourceName(`Saved capture · ${captureTimeLabel(capture.capturedAtMs)}`);
    setOcrSourceKind("history");
    try {
      const result = nativeRuntime
        ? await invoke<OcrResult>("recognize_history_capture_text", { id: capture.id })
        : {
            captureId: capture.id,
            sessionId: 1,
            text: "CAPSO ON-DEVICE OCR\nCapture first. Organise later.\n繁體中文同英文都會留喺呢部 Mac 處理。",
            lineCount: 3,
            truncated: false,
            engine: "apple_vision_on_device" as const,
            links: [],
          };
      setOcrResult(result);
      setNotice(result.text
        ? `Recognized ${result.lineCount} ${result.lineCount === 1 ? "line" : "lines"} on this Mac.`
        : "Apple Vision found no readable text in this capture.");
    } catch (reason) {
      setOcrCapture(null);
      setError(String(reason));
    } finally {
      endHistoryAction(actionKey);
    }
  }

  async function extractTextFromFile() {
    const actionKey = "ocr-file";
    if (!beginHistoryAction(actionKey)) return;
    try {
      const selected = nativeRuntime
        ? await invoke<SelectedOcrResult | null>("recognize_selected_png_text")
        : {
            sourceName: "Private Board.png",
            sourceBytes: 624_000,
            result: {
              captureId: "018f22c4-cada-7c6b-9d5b-fc35f7f99999",
              sessionId: 2,
              text: "PRIVATE LOCAL FILE\nApple Vision OCR\nhttps://capso.app/privacy",
              lineCount: 3,
              truncated: false,
              engine: "apple_vision_on_device" as const,
              links: ["https://capso.app/privacy"],
            },
          };
      if (!selected) {
        setNotice("No image chosen · nothing was read or imported.");
        return;
      }
      setOcrCapture({
        id: selected.result.captureId,
        path: "",
        capturedAtMs: Date.now(),
        bytes: selected.sourceBytes,
      });
      setOcrResult(selected.result);
      setOcrSourceName(selected.sourceName);
      setOcrSourceKind("file");
      setNotice(selected.result.text
        ? `Recognized ${selected.result.lineCount} ${selected.result.lineCount === 1 ? "line" : "lines"} from ${selected.sourceName}.`
        : `Apple Vision found no readable text in ${selected.sourceName}.`);
    } catch (reason) {
      setError(String(reason));
    } finally {
      endHistoryAction(actionKey);
    }
  }

  async function extractTextFromScreen() {
    const actionKey = "ocr-area";
    if (!beginHistoryAction(actionKey)) return;
    try {
      const selected = nativeRuntime
        ? await invoke<SelectedOcrResult | null>("recognize_screen_selection_text")
        : {
            sourceName: "Screen selection",
            sourceBytes: 418_000,
            result: {
              captureId: "018f22c4-cada-7c6b-9d5b-fc35f7f99998",
              sessionId: 3,
              text: "PRIVATE SCREEN SELECTION\nOn-device OCR only\nhttps://capso.app/privacy",
              lineCount: 3,
              truncated: false,
              engine: "apple_vision_on_device" as const,
              links: ["https://capso.app/privacy"],
            },
          };
      if (!selected) {
        setNotice("OCR area cancelled · no pixels were kept or read.");
        return;
      }
      setOcrCapture({
        id: selected.result.captureId,
        path: "",
        capturedAtMs: Date.now(),
        bytes: selected.sourceBytes,
      });
      setOcrResult(selected.result);
      setOcrSourceName(selected.sourceName);
      setOcrSourceKind("screen");
      setNotice(selected.result.text
        ? `Recognized ${selected.result.lineCount} ${selected.result.lineCount === 1 ? "line" : "lines"} from a private screen selection.`
        : "Apple Vision found no readable text in the selected screen area.");
    } catch (reason) {
      setError(String(reason));
    } finally {
      endHistoryAction(actionKey);
    }
  }

  async function copyOcrText() {
    const actionKey = "ocr-copy";
    if (!ocrResult || !ocrResult.text || !beginHistoryAction(actionKey)) return;
    try {
      if (nativeRuntime) {
        await invoke("copy_recognized_text", {
          captureId: ocrResult.captureId,
          sessionId: ocrResult.sessionId,
        });
      }
      setNotice("Copied the recognized text from this exact OCR session.");
    } catch (reason) {
      setError(String(reason));
    } finally {
      endHistoryAction(actionKey);
    }
  }

  async function copyOcrLink(linkIndex: number) {
    const actionKey = `ocr-copy-link:${linkIndex}`;
    if (!ocrResult?.links[linkIndex] || !beginHistoryAction(actionKey)) return;
    try {
      if (nativeRuntime) {
        await invoke("copy_recognized_link", {
          captureId: ocrResult.captureId,
          sessionId: ocrResult.sessionId,
          linkIndex,
        });
      }
      setNotice(`Copied detected web link ${linkIndex + 1} from this exact OCR session.`);
    } catch (reason) {
      setError(String(reason));
    } finally {
      endHistoryAction(actionKey);
    }
  }

  return (
    <main className="history-view">
      <header className="history-view__header" data-tauri-drag-region>
        <div data-tauri-drag-region>
          <p data-tauri-drag-region>CAPSO</p>
          <h1 data-tauri-drag-region>Capture history</h1>
          <span data-tauri-drag-region>Original pixels saved on this Mac.</span>
        </div>
        <div className="history-view__header-actions">
          <button
            type="button"
            disabled={busy !== null || compositionMode !== null}
            onClick={() => void extractTextFromScreen()}
          >{busy === "ocr-area" ? "Reading area…" : "OCR area…"}</button>
          <button
            type="button"
            disabled={busy !== null || compositionMode !== null}
            onClick={() => void extractTextFromFile()}
          >{busy === "ocr-file" ? "Reading image…" : "OCR image…"}</button>
          <button
            type="button"
            aria-pressed={compositionMode === "combine"}
            disabled={busy !== null}
            onClick={() => startComposing("combine")}
          >{compositionMode === "combine" ? "Cancel combine" : "Combine images"}</button>
          <button
            type="button"
            aria-pressed={compositionMode === "frame"}
            disabled={busy !== null}
            onClick={() => startComposing("frame")}
          >{compositionMode === "frame" ? "Cancel frame" : "Frame for social"}</button>
          <button type="button" disabled={busy !== null} onClick={() => void load()}>Refresh</button>
          <button type="button" disabled={busy !== null} onClick={() => void openWebLibrary()}>Open web library</button>
        </div>
      </header>

      <section className="history-view__toolbar" aria-label="History filters">
        <div>
          <strong>{snapshot ? (captureType === "all" && project === "all" && month === "all" ? snapshot.total : captures.length) : "—"}</strong>
          <span>{captureType === "all" && project === "all" && month === "all"
            ? snapshot?.total === 1 ? " local capture" : " local captures"
            : ` matching ${captures.length === 1 ? "capture" : "captures"} shown`}</span>
        </div>
        <div className="history-view__filters">
          <label>
            <span>Type</span>
            <select
              aria-label="Capture type"
              value={captureType}
              onChange={(event) => setCaptureType(event.currentTarget.value as HistoryCaptureFilter)}
            >
              <option value="all">All types</option>
              <option value="region">Area</option>
              <option value="window">Window</option>
              <option value="fullscreen">Full screen</option>
              <option value="created">Created in Capso</option>
              <option value="browser">Browser extension</option>
              <option value="recovered">Recovered</option>
              <option value="unknown">Unknown source</option>
            </select>
          </label>
          <label>
            <span>Project</span>
            <select
              aria-label="Capture project"
              value={project}
              onChange={(event) => setProject(event.currentTarget.value as HistoryProjectFilter)}
            >
              <option value="all">All projects</option>
              <option value="unfiled">Unfiled</option>
              {projectOptions.map((option) => (
                <option value={option.key} key={option.key}>{option.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Month</span>
            <select aria-label="Capture month" value={month} onChange={(event) => setMonth(event.currentTarget.value)}>
              <option value="all">All months</option>
              {months.map((option) => (
                <option value={option.key} key={option.key}>{option.label}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="history-view__clear"
            disabled={busy !== null || compositionMode !== null || !snapshot || snapshot.total === 0}
            onClick={() => setConfirmClear(true)}
          >Clear History…</button>
        </div>
      </section>

      {projectWarning && snapshot?.captures.some((capture) => capture.projectId) && (
        <p className="history-view__project-note" role="status">{projectWarning}</p>
      )}

      {confirmClear && (
        <section className="history-clear" role="dialog" aria-labelledby="history-clear-title">
          <div>
            <p>REMOVE FROM VIEW</p>
            <h2 id="history-clear-title">Clear History?</h2>
            <span>Files stay safe on this Mac. Uploads, editable projects and protected originals keep working.</span>
          </div>
          <div className="history-clear__actions">
            <button type="button" disabled={busy !== null} onClick={() => setConfirmClear(false)}>Keep History</button>
            <button type="button" disabled={busy !== null} onClick={() => void clearHistory()}>
              {busy === "clear-history" ? "Clearing…" : "Clear History"}
            </button>
          </div>
        </section>
      )}

      {compositionMode === "combine" && (
        <section className="history-combine" aria-label="Combine selected images">
          <div className="history-combine__heading">
            <div>
              <p>COMPOSITION</p>
              <h2>{combineSelection.length} of 8 selected</h2>
              <span>Drag to reorder. Full-resolution inputs stay unchanged.</span>
            </div>
            <label>
              <span>Layout</span>
              <select
                aria-label="Combined image layout"
                value={combineLayout}
                disabled={busy !== null}
                onChange={(event) => setCombineLayout(event.currentTarget.value as CombineLayout)}
              >
                <option value="horizontal">Horizontal</option>
                <option value="vertical">Vertical</option>
                <option value="grid">Grid</option>
              </select>
            </label>
          </div>
          {selectedCaptures.length === 0 ? (
            <div className="history-combine__empty">Choose captures from the grid below.</div>
          ) : (
            <ol
              className="history-combine__order"
              data-layout={combineLayout}
              data-count={selectedCaptures.length}
            >
              {selectedCaptures.map((capture, index) => {
                const source = nativeRuntime && capture.path
                  ? `${convertFileSrc(capture.path)}?combine=${capture.capturedAtMs}`
                  : null;
                return (
                  <li
                    key={capture.id}
                    data-capture-id={capture.id}
                    draggable={busy === null}
                    data-dragging={draggingCapture === capture.id}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", capture.id);
                      setDraggingCapture(capture.id);
                    }}
                    onDragEnd={() => setDraggingCapture(null)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      const movingCapture = event.dataTransfer.getData("text/plain");
                      if (combineSelection.includes(movingCapture)) {
                        setCombineSelection(reorderCombineSelection(
                          combineSelection,
                          movingCapture,
                          capture.id,
                        ));
                      }
                      setDraggingCapture(null);
                    }}
                  >
                    <span className="history-combine__thumbnail">
                      {source
                        ? <img src={source} alt="" draggable={false} />
                        : <span className="history-card__preview" data-variant={index % 4} aria-hidden="true" />}
                      <strong>{index + 1}</strong>
                    </span>
                    <span className="history-combine__item-actions">
                      <button
                        type="button"
                        aria-label={`Move image ${index + 1} earlier`}
                        disabled={busy !== null || index === 0}
                        onClick={() => moveCombinedCapture(capture.id, -1)}
                      >←</button>
                      <button
                        type="button"
                        aria-label={`Move image ${index + 1} later`}
                        disabled={busy !== null || index === selectedCaptures.length - 1}
                        onClick={() => moveCombinedCapture(capture.id, 1)}
                      >→</button>
                      <button
                        type="button"
                        aria-label={`Remove image ${index + 1} from combination`}
                        disabled={busy !== null}
                        onClick={() => setCombineSelection(toggleCombineSelection(combineSelection, capture.id))}
                      >×</button>
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
          <div className="history-combine__footer">
            <span>16px transparent gap · no scaling · one new PNG</span>
            <button
              type="button"
              disabled={!canCombineSelection(combineSelection) || busy !== null}
              onClick={() => void combine()}
            >{busy === "combine" ? "Combining…" : "Create combined capture"}</button>
          </div>
        </section>
      )}

      {compositionMode === "frame" && (
        <section className="history-frame" aria-label="Frame selected image for social delivery">
          <div className="history-frame__heading">
            <div>
              <p>DELIVERY FRAME</p>
              <h2>{framedCapture ? "1 capture selected" : "Choose one capture"}</h2>
              <span>Full-resolution pixels stay at 1:1. The frame becomes a new PNG.</span>
            </div>
            <label className="history-frame__balance">
              <input
                type="checkbox"
                checked={frameStyle.autoBalance}
                disabled={busy !== null}
                onChange={(event) => setFrameStyle({ ...frameStyle, autoBalance: event.currentTarget.checked })}
              />
              <span>Auto-balance</span>
            </label>
          </div>
          <div className="history-frame__workspace">
            <div
              className="history-frame__preview"
              data-aspect={frameStyle.aspect}
              data-background={frameStyle.background}
              data-padding={frameStyle.padding}
              data-alignment={frameStyle.autoBalance ? "center" : frameStyle.alignment}
              style={{
                "--history-frame-canvas": color.light.background,
                "--history-frame-ink": color.light.foreground,
                "--history-frame-blue": intent.reference,
                "--history-frame-custom": frameStyle.customBackground,
              } as CSSProperties}
            >
              {framedCapture ? (
                <span className="history-frame__source">
                  {nativeRuntime && framedCapture.path
                    ? <img
                        src={`${convertFileSrc(framedCapture.path)}?frame=${framedCapture.capturedAtMs}`}
                        alt="Selected capture preview"
                        draggable={false}
                      />
                    : <span className="history-card__preview" data-variant="2" aria-hidden="true" />}
                </span>
              ) : (
                <span className="history-frame__placeholder">Choose a capture from the grid</span>
              )}
            </div>
            <div className="history-frame__controls">
              <label>
                <span>Background</span>
                <select
                  aria-label="Social frame background"
                  value={frameStyle.background}
                  disabled={busy !== null}
                  onChange={(event) => setFrameStyle({
                    ...frameStyle,
                    background: event.currentTarget.value as FrameBackground,
                  })}
                >
                  <option value="canvas">Canvas</option>
                  <option value="ink">Ink</option>
                  <option value="blue">Capso blue</option>
                  <option value="custom">Custom</option>
                </select>
              </label>
              {frameStyle.background === "custom" && (
                <label>
                  <span>Exact colour</span>
                  <input
                    aria-label="Custom social frame colour"
                    value={frameStyle.customBackground}
                    spellCheck={false}
                    maxLength={7}
                    disabled={busy !== null}
                    onChange={(event) => setFrameStyle({
                      ...frameStyle,
                      customBackground: event.currentTarget.value.toUpperCase(),
                    })}
                    aria-invalid={!customFrameColourIsValid}
                  />
                </label>
              )}
              <label>
                <span>Padding</span>
                <select
                  aria-label="Social frame padding"
                  value={frameStyle.padding}
                  disabled={busy !== null}
                  onChange={(event) => setFrameStyle({
                    ...frameStyle,
                    padding: Number(event.currentTarget.value) as FramePadding,
                  })}
                >
                  <option value="24">24 px</option>
                  <option value="48">48 px</option>
                  <option value="96">96 px</option>
                  <option value="144">144 px</option>
                </select>
              </label>
              <label>
                <span>Aspect</span>
                <select
                  aria-label="Social frame aspect ratio"
                  value={frameStyle.aspect}
                  disabled={busy !== null}
                  onChange={(event) => setFrameStyle({
                    ...frameStyle,
                    aspect: event.currentTarget.value as FrameAspect,
                  })}
                >
                  <option value="auto">Auto</option>
                  <option value="square">1:1</option>
                  <option value="portrait">4:5</option>
                  <option value="story">9:16</option>
                  <option value="landscape">16:9</option>
                </select>
              </label>
              <label>
                <span>Alignment</span>
                <select
                  aria-label="Social frame alignment"
                  value={frameStyle.alignment}
                  disabled={busy !== null || frameStyle.autoBalance}
                  onChange={(event) => setFrameStyle({
                    ...frameStyle,
                    alignment: event.currentTarget.value as FrameAlignment,
                  })}
                >
                  <option value="top_left">Top left</option>
                  <option value="top">Top</option>
                  <option value="top_right">Top right</option>
                  <option value="left">Left</option>
                  <option value="center">Centre</option>
                  <option value="right">Right</option>
                  <option value="bottom_left">Bottom left</option>
                  <option value="bottom">Bottom</option>
                  <option value="bottom_right">Bottom right</option>
                </select>
              </label>
              <p>{frameStyle.autoBalance
                ? "Auto-balance centres any extra aspect space. Turn it off to position the capture manually."
                : "Manual alignment only moves through space added by the chosen aspect."}</p>
            </div>
          </div>
          <div className="history-frame__footer">
            <span>Opaque background · exact aspect · no source scaling</span>
            <button
              type="button"
              disabled={!framedCapture || busy !== null || (frameStyle.background === "custom" && !customFrameColourIsValid)}
              onClick={() => void frameForSocial()}
            >{busy === "frame" ? "Framing…" : "Create framed capture"}</button>
          </div>
        </section>
      )}

      <div className="history-view__notice" aria-live="polite">
        <span>{notice}</span>
        {removalUndo && (
          <button type="button" disabled={busy !== null} onClick={() => void undoHistoryRemoval()}>Undo</button>
        )}
      </div>
      {snapshot?.truncated && (
        <p className="history-view__limit">Showing the newest 500 originals. Older captures remain on this Mac.</p>
      )}
      {libraryMirror && (
        <div className="history-view__mirror" data-tone={libraryMirror.tone} role="status">
          <div>
            <strong>{libraryMirror.title}</strong>
            <span>{libraryMirror.message}</span>
          </div>
          {libraryMirror.action === "retry" && (
            <button type="button" onClick={() => void invoke("retry_sync")}>Retry download</button>
          )}
        </div>
      )}
      {error && (
        <div className="history-view__error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => void load()}>Try again</button>
        </div>
      )}
      {syncWarning && (
        <div className="history-view__error" role="status">
          <span>{syncWarning}</span>
          <button type="button" onClick={() => void load()}>Refresh status</button>
        </div>
      )}
      {!snapshot && !error && <div className="history-view__loading">Loading local history…</div>}
      {snapshot && captures.length === 0 && (
        <div className="history-view__empty">
          <strong>{snapshot.total === 0
            ? snapshot.removed > 0 ? "History is clear" : "No captures yet"
            : "No captures match these filters"}</strong>
          <span>{snapshot.total === 0
            ? snapshot.removed > 0
              ? `${snapshot.removed} ${snapshot.removed === 1 ? "capture is" : "captures are"} hidden from History; files remain safe on this Mac.`
              : "Your next successful capture will appear here."
            : "Choose another type, project or month to keep looking."}</span>
        </div>
      )}
      {captures.length > 0 && (
        <ul className="history-view__grid" aria-label="Local captures">
          {captures.map((capture, index) => {
            const sync = historySyncPresentation(capture, projectSyncByCapture.get(capture.id));
            const source = nativeRuntime && capture.path
              ? `${convertFileSrc(capture.path)}?history=${capture.capturedAtMs}&revision=${capture.annotationRevision ?? 0}`
              : null;
            const combineIndex = combineSelection.indexOf(capture.id);
            const selectedForCombine = combineIndex >= 0;
            const selectedForFrame = frameSelection[0] === capture.id;
            const selectedForComposition = selectedForCombine || selectedForFrame;
            const combineSelectionFull = combineSelection.length >= 8 && !selectedForCombine;
            return (
              <li key={capture.id} className="history-card-shell">
                <button
                  type="button"
                  className="history-card"
                  data-composition-selected={selectedForComposition}
                  disabled={busy !== null || (compositionMode === "combine" && combineSelectionFull)}
                  aria-pressed={compositionMode ? selectedForComposition : undefined}
                  onClick={(event) => {
                    if (compositionMode === "combine") {
                      setCombineSelection(toggleCombineSelection(combineSelection, capture.id));
                    } else if (compositionMode === "frame") {
                      setFrameSelection(selectFrameCapture(frameSelection, capture.id));
                    } else {
                      const action = historyCardClickAction(event.detail);
                      if (action === "open_now") {
                        cancelPendingCardOpen();
                        void restore(capture);
                      } else if (action === "cancel_pending_open") {
                        cancelPendingCardOpen();
                      } else {
                        cancelPendingCardOpen();
                        pendingCardOpen.current = window.setTimeout(() => {
                          pendingCardOpen.current = null;
                          void restore(capture);
                        }, 300);
                      }
                    }
                  }}
                  onDoubleClick={(event) => {
                    if (compositionMode) return;
                    event.preventDefault();
                    cancelPendingCardOpen();
                    void annotate(capture);
                  }}
                  aria-label={compositionMode === "combine"
                    ? `${selectedForCombine ? "Remove" : "Add"} capture from ${captureTimeLabel(capture.capturedAtMs)} ${selectedForCombine ? "from" : "to"} combination`
                    : compositionMode === "frame"
                      ? `${selectedForFrame ? "Remove" : "Use"} capture from ${captureTimeLabel(capture.capturedAtMs)} ${selectedForFrame ? "from" : "for"} social frame`
                      : `Open capture from ${captureTimeLabel(capture.capturedAtMs)} in Quick Access`}
                >
                  <span className="history-card__image">
                    {source
                      ? <img
                          src={source}
                          alt=""
                          draggable={false}
                          onError={(event) => { event.currentTarget.hidden = true; }}
                        />
                      : <span className="history-card__preview" data-variant={index % 4} aria-hidden="true" />}
                    {selectedForComposition && (
                      <strong className="history-card__combine-order">
                        {selectedForCombine ? combineIndex + 1 : "✓"}
                      </strong>
                    )}
                    <span>{busy === capture.id
                      ? "Opening…"
                      : compositionMode === "combine"
                        ? selectedForCombine ? "Remove from combination" : "Add to combination"
                        : compositionMode === "frame"
                          ? selectedForFrame ? "Remove from frame" : "Use for social frame"
                        : "Open in Quick Access"}</span>
                  </span>
                  <span className="history-card__meta">
                    <strong>{captureTimeLabel(capture.capturedAtMs)}</strong>
                    <small>
                      {captureSizeLabel(capture.bytes)} · {capture.annotationRevision
                        ? `Editable revision ${capture.annotationRevision}`
                        : "Flattened capture"}
                    </small>
                    <small>{historyCaptureKindLabel(capture.source)}</small>
                    <small>{historyProjectLabel(capture, projects)}</small>
                    <span className="history-card__sync" data-tone={sync.tone}>{sync.label}</span>
                    <small>{sync.detail}</small>
                  </span>
                </button>
                {!compositionMode && (
                  <div className="history-card__actions">
                    <button
                      type="button"
                      className="history-card__edit"
                      disabled={busy !== null}
                      onClick={() => void annotate(capture)}
                      aria-label={`${capture.annotationRevision ? "Edit annotation" : "Annotate"} from ${captureTimeLabel(capture.capturedAtMs)}`}
                    >
                      {busy === capture.id
                        ? "Opening editor…"
                        : capture.annotationRevision ? "Edit annotation" : "Annotate"}
                    </button>
                    <button
                      type="button"
                      className="history-card__ocr"
                      disabled={busy !== null}
                      onClick={() => void extractText(capture)}
                      aria-label={`Extract text from ${captureTimeLabel(capture.capturedAtMs)}`}
                    >
                      {busy === `ocr:${capture.id}` ? "Reading on-device…" : "Extract text"}
                    </button>
                    <button
                      type="button"
                      className="history-card__remove"
                      disabled={busy !== null}
                      onClick={() => void removeFromHistory(capture)}
                      aria-label={`Remove capture from ${captureTimeLabel(capture.capturedAtMs)} from History`}
                    >
                      {busy === `remove:${capture.id}` ? "Removing…" : "Remove from History"}
                    </button>
                  </div>
                )}
                {!compositionMode && sync.action === "retry" && (
                  <button
                    type="button"
                    className="history-card__recovery"
                    disabled={busy !== null}
                    onClick={() => void recoverProject(capture, "retry")}
                  >
                    {busy === capture.id ? "Queuing…" : "Retry project sync"}
                  </button>
                )}
                {!compositionMode && sync.action === "keep_local" && (
                  <button
                    type="button"
                    className="history-card__recovery"
                    data-conflict="true"
                    disabled={busy !== null}
                    onClick={() => void recoverProject(capture, "keep_local")}
                  >
                    {busy === capture.id ? "Queuing…" : "Keep this Mac version"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {ocrCapture && (
        <div className="history-ocr-backdrop" role="presentation">
          <section
            className="history-ocr"
            role="dialog"
            aria-modal="true"
            aria-labelledby="history-ocr-title"
          >
            <header className="history-ocr__header">
              <div>
                <p>PRIVATE TEXT EXTRACTION</p>
                <h2 id="history-ocr-title">Recognized text</h2>
                <span>{ocrSourceName ?? "Local PNG"} · On-device Apple Vision · nothing uploaded</span>
              </div>
              <button
                type="button"
                autoFocus
                aria-label="Close recognized text"
                disabled={ocrCopyBusy}
                onClick={() => {
                  setOcrCapture(null);
                  setOcrResult(null);
                  setOcrSourceName(null);
                  setOcrSourceKind(null);
                }}
              >×</button>
            </header>
            <div className="history-ocr__body" data-has-links={Boolean(ocrResult?.links.length)}>
              {ocrResult ? (
                <>
                  <textarea
                    aria-label="Recognized text"
                    readOnly
                    spellCheck={false}
                    value={ocrResult.text || "No readable text was found in this capture."}
                  />
                  <div className="history-ocr__meta">
                    <span>{ocrResult.lineCount} {ocrResult.lineCount === 1 ? "line" : "lines"}</span>
                    <span>{ocrResult.truncated ? "Safe output limit reached" : "Complete result"}</span>
                  </div>
                  {ocrResult.links.length > 0 && (
                    <section className="history-ocr__links" aria-labelledby="history-ocr-links-title">
                      <div>
                        <strong id="history-ocr-links-title">Detected web links</strong>
                        <span>Copy only · Capso never opens these automatically</span>
                      </div>
                      <ol>
                        {ocrResult.links.map((link, index) => (
                          <li key={`${index}:${link}`}>
                            <span>{link}</span>
                            <button
                              type="button"
                              aria-label={`Copy link ${index + 1}: ${link}`}
                              disabled={ocrCopyBusy}
                              onClick={() => void copyOcrLink(index)}
                            >{busy === `ocr-copy-link:${index}` ? "Copying…" : "Copy link"}</button>
                          </li>
                        ))}
                      </ol>
                    </section>
                  )}
                </>
              ) : (
                <div className="history-ocr__loading" role="status">
                  <span aria-hidden="true" />
                  <strong>Reading this capture on-device…</strong>
                  <small>Accurate multilingual recognition can take a moment.</small>
                </div>
              )}
            </div>
            <footer className="history-ocr__footer">
              <span>{ocrSourceKind === "screen"
                ? "Selected screen pixels are removed immediately after recognition; recognized text stays on this Mac."
                : ocrSourceKind === "file"
                  ? "The selected PNG stays in its original location; recognized text stays on this Mac."
                  : "The saved capture stays unchanged; recognized text stays on this Mac."}</span>
              <button
                type="button"
                disabled={!ocrResult?.text || ocrCopyBusy}
                onClick={() => void copyOcrText()}
              >{busy === "ocr-copy" ? "Copying…" : "Copy text"}</button>
            </footer>
          </section>
        </div>
      )}
    </main>
  );
}
