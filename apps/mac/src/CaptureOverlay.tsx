import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  OverlayActionCoordinator,
  type OverlayActionKind,
  type OverlayActionToken,
} from "./overlay-actions";
import {
  OverlayDragGesture,
  saveAsFilters,
  suggestedCaptureFilename,
  type OverlaySaveAsPreferences,
} from "./overlay-drag";
import {
  overlaySyncPresentation,
  type CaptureSyncStatus,
} from "./overlay-sync";
import {
  captureProjectList,
  type CaptureProject,
} from "./overlay-projects";
import {
  overlayCapturedAt,
  overlayFileSize,
  type OverlayFileInfo,
} from "./overlay-file-info";
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

type PinCaptureResult = {
  path: string;
  presentationId: number;
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

const PREVIEW_MODE = new URLSearchParams(window.location.search).get("preview");
const PREVIEW_IS_HISTORY = PREVIEW_MODE === "history";
const PREVIEW_MINIMAL_ACTIONS = PREVIEW_MODE === "minimal-actions";
const PREVIEW_CAPTURE: PresentedCapture = {
  path: "",
  presentationId: 0,
  clipboard: PREVIEW_IS_HISTORY
    ? { status: "unchanged" }
    : { status: "copied", bytes: 248_320 },
  source: PREVIEW_IS_HISTORY ? "history" : "capture",
  autoDismissMs: 8_000,
  quickActions: PREVIEW_MINIMAL_ACTIONS
    ? { pin: true, annotate: false, copy: false, save: false }
    : { pin: true, annotate: true, copy: true, save: true },
  temporarilyHidden: false,
  presentation: 0,
};
const PREVIEW_SYNC_STATUS: CaptureSyncStatus = {
  status: PREVIEW_IS_HISTORY ? "synced" : "ready",
};
const PREVIEW_PROJECTS: CaptureProject[] = [
  { id: "018f22c4-cada-7c6b-9d5b-fc35f7f92276", name: "Launch research" },
  { id: "018f22c4-cada-7c6b-9d5b-fc35f7f92277", name: "Design references" },
];
const PREVIEW_FILE_INFO: OverlayFileInfo = {
  format: "PNG",
  bytes: 248_320,
  capturedAtMs: new Date(2026, 7, 12, 21, 5).getTime(),
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

function AnnotateIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m4 16 3.1-.7L15.4 7a1.7 1.7 0 0 0-2.4-2.4l-8.3 8.3L4 16Z" />
      <path d="m11.8 5.8 2.4 2.4" />
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

function PinIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M7 4h6l-1 4 2.5 2.5v1H5.5v-1L8 8 7 4Z" />
      <path d="M10 11.5V17" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="6.5" />
      <path d="M10 9v4" />
      <path d="M10 6.6h.01" />
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

function HideIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M5 10h10" />
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
  const [temporarilyHidden, setTemporarilyHidden] = useState(false);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeIsWarning, setNoticeIsWarning] = useState(false);
  const [syncStatus, setSyncStatus] = useState<CaptureSyncStatus | null>(() =>
    nativeRuntime ? null : PREVIEW_SYNC_STATUS,
  );
  const [projects, setProjects] = useState<CaptureProject[]>(() =>
    nativeRuntime ? [] : PREVIEW_PROJECTS,
  );
  const [projectsLoaded, setProjectsLoaded] = useState(!nativeRuntime);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [fileInfo, setFileInfo] = useState<OverlayFileInfo | null>(() =>
    nativeRuntime ? null : PREVIEW_FILE_INFO,
  );
  const [fileInfoLoaded, setFileInfoLoaded] = useState(!nativeRuntime);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const revealedPresentation = useRef<number | null>(null);
  const projectChip = useRef<HTMLButtonElement | null>(null);
  const projectMenu = useRef<HTMLDivElement | null>(null);
  const fileChip = useRef<HTMLButtonElement | null>(null);
  const fileMenu = useRef<HTMLDivElement | null>(null);
  const dragGesture = useRef(new OverlayDragGesture(6));
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

  useEffect(() => {
    if (!nativeRuntime) return;

    let disposed = false;
    let receivedLiveCapture = false;
    let unlisten: UnlistenFn | undefined;
    let unlistenDrag: UnlistenFn | undefined;
    let unlistenRestore: UnlistenFn | undefined;

    void (async () => {
      unlisten = await listen<OverlayCapture>("overlay-capture", (event) => {
        if (disposed) return;
        receivedLiveCapture = true;
        dragGesture.current.reset();
        dragAction.current = null;
        const presentation = actionCoordinator.current!.activateCapture(event.payload.path);
        revealedPresentation.current = null;
        setImageFailed(false);
        setImageReady(false);
        setTemporarilyHidden(event.payload.temporarilyHidden);
        setBusyAction(null);
        setNotice(null);
        setNoticeIsWarning(false);
        setSyncStatus(null);
        setProjectMenuOpen(false);
        setProjectBusy(false);
        setProjectError(null);
        setSelectedProjectId(null);
        setFileMenuOpen(false);
        setFileInfo(null);
        setFileInfoLoaded(false);
        setFileLoading(false);
        setFileError(null);
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
      unlistenRestore = await listen<OverlayRestored>("overlay-restored", (event) => {
        if (disposed) return;
        setCapture((current) => {
          if (
            current?.path === event.payload.path &&
            current.presentationId === event.payload.presentationId
          ) {
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
        unlistenRestore?.();
        return;
      }

      const current = await invoke<OverlayCapture | null>("get_overlay_capture");
      if (!disposed && !receivedLiveCapture && current) {
        const presentation = actionCoordinator.current!.activateCapture(current.path);
        setTemporarilyHidden(current.temporarilyHidden);
        setCapture({ ...current, presentation });
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
      unlistenDrag?.();
      unlistenRestore?.();
    };
  }, [nativeRuntime]);

  useEffect(() => {
    if (!nativeRuntime || !capture?.path) return;
    let active = true;
    const { path, presentation, presentationId } = capture;

    const refresh = () => {
      void invoke<CaptureSyncStatus>("get_overlay_sync_status", {
        path,
        presentationId,
      })
        .then((status) => {
          if (
            active &&
            actionCoordinator.current?.generation() === presentation
          ) {
            setSyncStatus(status);
          }
        })
        .catch(() => {
          if (
            active &&
            actionCoordinator.current?.generation() === presentation
          ) {
            setSyncStatus({ status: "unavailable" });
          }
        });
    };

    refresh();
    const syncListener = listen("sync-status-changed", refresh);
    const captureListener = listen("capture-finished", refresh);
    const handleFocus = () => refresh();
    window.addEventListener("focus", handleFocus);
    return () => {
      active = false;
      window.removeEventListener("focus", handleFocus);
      void syncListener.then((unlisten) => unlisten());
      void captureListener.then((unlisten) => unlisten());
    };
  }, [capture?.path, capture?.presentation, capture?.presentationId, nativeRuntime]);

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

  async function hideTemporarily() {
    if (!nativeRuntime || !capture?.path) return;
    const { path, presentationId } = capture;
    const action = actionCoordinator.current?.begin(path, "hide");
    if (!action) return;
    autoDismiss.current?.pause();
    setBusyAction("hide");
    setNoticeIsWarning(false);
    try {
      const hidden = await invoke<boolean>("overlay_hide_temporarily", {
        path,
        presentationId,
      });
      if (hidden && actionCoordinator.current?.isCurrent(action)) {
        setTemporarilyHidden(true);
        setNotice("Hidden · restore from the Capso menu");
      }
    } catch (error) {
      if (actionCoordinator.current?.isCurrent(action)) {
        setTemporarilyHidden(false);
        setNotice(`Could not hide: ${String(error)}`);
        setNoticeIsWarning(true);
      }
    } finally {
      if (actionCoordinator.current?.finish(action)) setBusyAction(null);
    }
  }

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

  useEffect(() => {
    const shouldRun =
      nativeRuntime &&
      Boolean(capture?.path) &&
      capture?.autoDismissMs !== null &&
      imageReady &&
      !imageFailed &&
      !temporarilyHidden &&
      !hovered &&
      busyAction === null &&
      !projectMenuOpen &&
      !projectBusy &&
      !fileMenuOpen &&
      !fileLoading;
    if (shouldRun) autoDismiss.current?.start();
    else autoDismiss.current?.pause();
  }, [
    busyAction,
    capture?.path,
    hovered,
    imageFailed,
    imageReady,
    nativeRuntime,
    fileLoading,
    fileMenuOpen,
    projectBusy,
    projectMenuOpen,
    temporarilyHidden,
  ]);

  useEffect(() => () => autoDismiss.current?.cancel(), []);

  useEffect(() => {
    if (!projectMenuOpen) return;
    const frame = window.requestAnimationFrame(() => {
      const items = Array.from(
        projectMenu.current?.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']") ?? [],
      );
      (items.find((item) => item.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [projectMenuOpen]);

  useEffect(() => {
    if (!fileMenuOpen || fileLoading || !fileInfo) return;
    const frame = window.requestAnimationFrame(() => {
      fileMenu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [fileInfo, fileLoading, fileMenuOpen]);

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

  async function annotateCapture() {
    if (!nativeRuntime || !capture?.path || capture.source === "history") return;
    const path = capture.path;
    const presentationId = capture.presentationId;
    const action = actionCoordinator.current?.begin(path, "annotate");
    if (!action) return;
    setBusyAction("annotate");
    setNoticeIsWarning(false);
    let opened = false;
    try {
      await invoke("open_annotation_editor", { path, presentationId });
      opened = true;
    } catch (error) {
      if (actionCoordinator.current?.isCurrent(action)) {
        setNotice(`Annotate failed: ${String(error)}`);
        setNoticeIsWarning(true);
      }
    } finally {
      if (!opened && actionCoordinator.current?.finish(action)) setBusyAction(null);
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
      const saveAsPreferences = await invoke<OverlaySaveAsPreferences>(
        "get_save_as_preferences",
      );
      const destination = await save({
        title: "Save Capso Capture",
        defaultPath: suggestedCaptureFilename(new Date(), saveAsPreferences),
        filters: saveAsFilters(saveAsPreferences.format),
        canCreateDirectories: true,
      });
      if (!destination) return;

      const result = await invoke<OverlaySaveResult>("overlay_save_capture", {
        path,
        presentationId,
        destination,
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

  async function pinCapture() {
    if (!nativeRuntime || !capture?.path || imageFailed) return;
    const path = capture.path;
    const presentationId = capture.presentationId;
    const action = actionCoordinator.current?.begin(path, "pin");
    if (!action) return;
    setBusyAction("pin");
    setNoticeIsWarning(false);
    try {
      await invoke<PinCaptureResult>("pin_overlay_capture", { path, presentationId });
      if (actionCoordinator.current?.isCurrent(action)) setNotice("Pinned above your work");
    } catch (error) {
      if (actionCoordinator.current?.isCurrent(action)) {
        setNotice(`Pin failed: ${String(error)}`);
        setNoticeIsWarning(true);
      }
    } finally {
      if (actionCoordinator.current?.finish(action)) setBusyAction(null);
    }
  }

  async function startDragCapture() {
    if (!nativeRuntime || !capture?.path || !imageReady || imageFailed) return;
    const path = capture.path;
    const presentationId = capture.presentationId;
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

  async function toggleProjectMenu() {
    if (!capture || capture.source === "history" || projectBusy) return;
    if (projectMenuOpen) {
      setProjectMenuOpen(false);
      return;
    }
    setProjectMenuOpen(true);
    setProjectError(null);
    if (projectsLoaded || !nativeRuntime) return;

    const generation = capture.presentation;
    setProjectBusy(true);
    try {
      const value = await invoke<unknown>("get_capture_projects");
      if (actionCoordinator.current?.generation() !== generation) return;
      const list = captureProjectList(value);
      if (!list) throw new Error("Capso received an invalid project list.");
      setProjects(list);
      setProjectsLoaded(true);
    } catch (error) {
      if (actionCoordinator.current?.generation() === generation) {
        setProjectError(String(error));
      }
    } finally {
      if (actionCoordinator.current?.generation() === generation) setProjectBusy(false);
    }
  }

  async function assignProject(project: CaptureProject | null) {
    if (!capture || capture.source === "history" || projectBusy) return;
    const { path, presentation, presentationId } = capture;
    setProjectBusy(true);
    setProjectError(null);
    try {
      if (nativeRuntime) {
        await invoke("assign_overlay_project", {
          path,
          presentationId,
          projectId: project?.id ?? null,
        });
      }
      if (actionCoordinator.current?.generation() === presentation) {
        setSelectedProjectId(project?.id ?? null);
        setProjectMenuOpen(false);
        setNotice(project ? `Filed to ${project.name}` : "Capso will choose the project");
        setNoticeIsWarning(false);
      }
    } catch (error) {
      if (actionCoordinator.current?.generation() === presentation) {
        setProjectError(String(error));
      }
    } finally {
      if (actionCoordinator.current?.generation() === presentation) setProjectBusy(false);
    }
  }

  async function toggleFileMenu() {
    if (!capture || fileLoading) return;
    if (fileMenuOpen) {
      setFileMenuOpen(false);
      return;
    }
    setProjectMenuOpen(false);
    setFileMenuOpen(true);
    setFileError(null);
    if (fileInfoLoaded || !nativeRuntime) return;

    const { path, presentation, presentationId } = capture;
    setFileLoading(true);
    try {
      const value = await invoke<OverlayFileInfo>("get_overlay_file_info", {
        path,
        presentationId,
      });
      if (actionCoordinator.current?.generation() === presentation) {
        setFileInfo(value);
        setFileInfoLoaded(true);
      }
    } catch (error) {
      if (actionCoordinator.current?.generation() === presentation) {
        setFileError(String(error));
      }
    } finally {
      if (actionCoordinator.current?.generation() === presentation) setFileLoading(false);
    }
  }

  async function runFileAction(kind: "reveal" | "open") {
    if (!fileInfo) return;
    if (!nativeRuntime) {
      setFileMenuOpen(false);
      setNotice(kind === "reveal" ? "Selected the original in Finder" : "Opened the local original");
      setNoticeIsWarning(false);
      return;
    }
    if (!capture?.path) return;
    const { path, presentationId } = capture;
    const action = actionCoordinator.current?.begin(path, kind);
    if (!action) return;
    setBusyAction(kind);
    setFileError(null);
    setNoticeIsWarning(false);
    try {
      await invoke(kind === "reveal" ? "reveal_overlay_capture" : "open_overlay_capture", {
        path,
        presentationId,
      });
      if (actionCoordinator.current?.isCurrent(action)) {
        setFileMenuOpen(false);
        setNotice(kind === "reveal" ? "Selected the original in Finder" : "Opened the local original");
      }
    } catch (error) {
      if (actionCoordinator.current?.isCurrent(action)) {
        setFileError(String(error));
        setNotice(kind === "reveal" ? "Could not show the original in Finder" : "Could not open the original");
        setNoticeIsWarning(true);
      }
    } finally {
      if (actionCoordinator.current?.finish(action)) setBusyAction(null);
    }
  }

  if (!capture) {
    return <main className="capture-overlay capture-overlay--waiting" aria-hidden="true" />;
  }

  const source = nativeRuntime && capture.path
    ? `${convertFileSrc(capture.path)}?presentation=${capture.presentationId}`
    : null;
  const clipboardCopy =
    capture.clipboard.status === "copied"
      ? "Copied to clipboard"
      : capture.clipboard.status === "unchanged"
        ? "Ready to copy"
        : "Copy unavailable";
  const syncPresentation = syncStatus ? overlaySyncPresentation(syncStatus) : null;
  const statusCopy = notice ?? syncPresentation?.copy ?? clipboardCopy;
  const statusDetail = notice ?? syncPresentation?.detail ?? clipboardCopy;
  const statusIsWarning = notice
    ? noticeIsWarning
    : syncPresentation?.tone === "warning";
  const isHistory = capture.source === "history";
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;

  return (
    <main
      key={capture.path ? `${capture.path}:${capture.presentationId}` : "preview"}
      className="capture-overlay"
      role="region"
      aria-label={isHistory ? "Restored Capso capture" : "Latest Capso capture"}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
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
              if (!dragGesture.current.move(event.pointerId, event.clientX, event.clientY)) {
                return;
              }
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              void startDragCapture();
            }}
            onPointerUp={(event) => dragGesture.current.end(event.pointerId)}
            onPointerCancel={(event) => dragGesture.current.end(event.pointerId)}
            onLoad={() => {
              setImageReady(true);
              reveal();
            }}
            onError={() => {
              dragGesture.current.reset();
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

        {fileMenuOpen && (
          <div
            className="capture-overlay__project-scrim"
            aria-hidden="true"
            onPointerDown={() => {
              setFileMenuOpen(false);
              fileChip.current?.focus();
            }}
          />
        )}
        <button
          type="button"
          className="capture-overlay__hide"
          aria-label="Hide Quick Access temporarily"
          title="Hide until restored from the Capso menu"
          disabled={busyAction !== null || projectBusy}
          onClick={() => void hideTemporarily()}
        >
          <HideIcon />
        </button>
        <button
          type="button"
          ref={fileChip}
          className="capture-overlay__file-chip"
          aria-label="Capture file information"
          aria-haspopup="dialog"
          aria-expanded={fileMenuOpen}
          aria-controls="capture-file-info"
          title="Local original info"
          disabled={busyAction !== null || projectBusy || projectMenuOpen || fileLoading}
          onClick={() => void toggleFileMenu()}
        >
          <InfoIcon />
        </button>
        {fileMenuOpen && (
          <div
            id="capture-file-info"
            ref={fileMenu}
            className="capture-overlay__file-menu"
            role="dialog"
            aria-label="Local original information"
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              setFileMenuOpen(false);
              fileChip.current?.focus();
            }}
          >
            <strong>Local original</strong>
            {fileLoading && <p>Checking file…</p>}
            {fileInfo && (
              <p>
                <span>{fileInfo.format} · {overlayFileSize(fileInfo.bytes)}</span>
                <small>{overlayCapturedAt(fileInfo.capturedAtMs)}</small>
              </p>
            )}
            {fileError && <p data-error="true">{fileError}</p>}
            <div>
              <button
                type="button"
                disabled={!fileInfo || busyAction !== null}
                onClick={() => void runFileAction("open")}
              >
                Open
              </button>
              <button
                type="button"
                disabled={!fileInfo || busyAction !== null}
                onClick={() => void runFileAction("reveal")}
              >
                Show in Finder
              </button>
            </div>
          </div>
        )}

        {!isHistory && (
          <>
            {projectMenuOpen && (
              <div
                className="capture-overlay__project-scrim"
                aria-hidden="true"
                onPointerDown={() => {
                  setProjectMenuOpen(false);
                  projectChip.current?.focus();
                }}
              />
            )}
            <button
              type="button"
              ref={projectChip}
              className="capture-overlay__project-chip"
              aria-haspopup="menu"
              aria-expanded={projectMenuOpen}
              title="Choose where this capture is filed"
              disabled={busyAction !== null || projectBusy || fileMenuOpen || fileLoading}
              onClick={() => void toggleProjectMenu()}
            >
              <span aria-hidden="true">⌄</span>
              {selectedProject?.name ?? "File"}
            </button>
            {projectMenuOpen && (
              <div
                ref={projectMenu}
                className="capture-overlay__project-menu"
                role="menu"
                aria-label="File capture to project"
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setProjectMenuOpen(false);
                    projectChip.current?.focus();
                    return;
                  }
                  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
                  const items = Array.from(
                    projectMenu.current?.querySelectorAll<HTMLButtonElement>(
                      "[role='menuitemradio']",
                    ) ?? [],
                  );
                  if (items.length === 0) return;
                  event.preventDefault();
                  const active = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
                  const next = event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? items.length - 1
                      : event.key === "ArrowDown"
                        ? (active + 1) % items.length
                        : (active - 1 + items.length) % items.length;
                  items[next]?.focus();
                }}
              >
                <strong>File this capture</strong>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={selectedProjectId === null}
                  onClick={() => void assignProject(null)}
                >
                  <span>Let Capso decide</span>
                  {selectedProjectId === null && <small aria-hidden="true">✓</small>}
                </button>
                {projects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selectedProjectId === project.id}
                    onClick={() => void assignProject(project)}
                  >
                    <span>{project.name}</span>
                    {selectedProjectId === project.id && <small aria-hidden="true">✓</small>}
                  </button>
                ))}
                {projectBusy && <p>Loading projects…</p>}
                {!projectBusy && projectsLoaded && projects.length === 0 && (
                  <p>No active projects yet.</p>
                )}
                {projectError && <p data-error="true">{projectError}</p>}
              </div>
            )}
          </>
        )}

        <button
          type="button"
          className="capture-overlay__close"
          aria-label="Close capture overlay"
          title="Close"
          disabled={busyAction !== null || projectBusy}
          onClick={() => void dismiss("close")}
        >
          <CloseIcon />
        </button>
      </div>

      <footer className="capture-overlay__footer">
        <span
          className="capture-overlay__mark"
          data-tone={notice ? (noticeIsWarning ? "warning" : "neutral") : syncPresentation?.tone}
          aria-hidden="true"
        />
        <span className="capture-overlay__message">
          <strong>{isHistory ? "Recent capture" : "Capture saved"}</strong>
          <small
            data-warning={statusIsWarning}
            title={statusDetail}
            aria-live="polite"
          >
            {statusCopy}
          </small>
        </span>
          <span className="capture-overlay__actions" role="toolbar" aria-label="Capture actions">
            {capture.quickActions.pin && <button
            type="button"
            className="capture-overlay__action"
            aria-label="Pin capture"
            title="Pin above your work"
            data-busy={busyAction === "pin"}
            disabled={busyAction !== null || projectBusy || imageFailed}
            onClick={() => void pinCapture()}
          >
            <PinIcon />
            </button>}
            {capture.quickActions.annotate && <button
            type="button"
            className="capture-overlay__action"
            aria-label="Annotate capture"
            title={isHistory ? "Annotation is available immediately after capture" : "Annotate"}
            data-busy={busyAction === "annotate"}
            disabled={busyAction !== null || projectBusy || imageFailed || isHistory}
            onClick={() => void annotateCapture()}
          >
            <AnnotateIcon />
            </button>}
            {capture.quickActions.copy && <button
            type="button"
            className="capture-overlay__action"
            aria-label="Copy capture"
            title="Copy"
            data-busy={busyAction === "copy"}
            disabled={busyAction !== null || projectBusy || imageFailed}
            onClick={() => void copyCapture()}
          >
            <CopyIcon />
            </button>}
            {capture.quickActions.save && <button
                type="button"
                className="capture-overlay__action"
                aria-label="Save capture as PNG or JPEG"
            title="Save As…"
            data-busy={busyAction === "save"}
            disabled={busyAction !== null || projectBusy || imageFailed}
            onClick={() => void saveCapture()}
          >
            <SaveIcon />
            </button>}
        </span>
      </footer>
    </main>
  );
}
