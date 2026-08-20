export type HistoryCaptureSource = "region" | "window" | "fullscreen" | "created" | "browser" | "recovered";
export type HistoryCaptureFilter = "all" | HistoryCaptureSource | "unknown";
export type HistoryProjectFilter = "all" | "unfiled" | "unavailable" | string;

export type HistoryProject = {
  id: string;
  name: string;
};

export type LocalHistoryCapture = {
  id: string;
  path: string;
  capturedAtMs: number;
  bytes: number;
  source?: HistoryCaptureSource;
  projectId?: string;
  annotationRevision?: number;
};

export type HistorySnapshot = {
  captures: LocalHistoryCapture[];
  total: number;
  removed: number;
  truncated: boolean;
};

export type HistoryLibraryMirrorPresentation = {
  title: string;
  message: string;
  tone: "progress" | "warning";
  action: "retry" | null;
};

export function historyLibraryMirrorPresentation(
  remotePending: number,
  warning: string | null,
): HistoryLibraryMirrorPresentation | null {
  if (!Number.isSafeInteger(remotePending) || remotePending <= 0) return null;
  if (warning !== null) {
    return {
      title: "Library download paused",
      message: "Your cloud library remains private and unchanged.",
      tone: "warning",
      action: "retry",
    };
  }
  return {
    title: `Downloading ${remotePending} ${remotePending === 1 ? "capture" : "captures"} to this Mac`,
    message: "They will appear here automatically. You can keep working.",
    tone: "progress",
    action: null,
  };
}

export type HistoryCardClickAction =
  | "open_now"
  | "wait_for_double_click"
  | "cancel_pending_open";

export function historyCardClickAction(detail: number): HistoryCardClickAction {
  if (detail === 0) return "open_now";
  if (detail > 1) return "cancel_pending_open";
  return "wait_for_double_click";
}

export function removeHistoryPreview(snapshot: HistorySnapshot, ids: string[]): HistorySnapshot {
  const hidden = new Set(ids);
  const captures = snapshot.captures.filter((capture) => !hidden.has(capture.id));
  const removed = snapshot.captures.length - captures.length;
  if (removed === 0) return snapshot;
  return {
    ...snapshot,
    captures,
    total: Math.max(0, snapshot.total - removed),
    removed: snapshot.removed + removed,
  };
}

export function restoreHistoryPreview(
  snapshot: HistorySnapshot,
  restored: LocalHistoryCapture[],
): HistorySnapshot {
  const existing = new Set(snapshot.captures.map((capture) => capture.id));
  const additions = restored.filter((capture) => !existing.has(capture.id));
  if (additions.length === 0) return snapshot;
  const captures = [...snapshot.captures, ...additions].sort((left, right) =>
    right.capturedAtMs - left.capturedAtMs || right.id.localeCompare(left.id));
  return {
    ...snapshot,
    captures,
    total: snapshot.total + additions.length,
    removed: Math.max(0, snapshot.removed - additions.length),
  };
}

export const MAX_COMBINE_SELECTION = 8;

export function toggleCombineSelection(selected: string[], id: string): string[] {
  const existing = selected.indexOf(id);
  if (existing >= 0) return selected.filter((candidate) => candidate !== id);
  if (selected.length >= MAX_COMBINE_SELECTION) return selected;
  return [...selected, id];
}

export function canCombineSelection(selected: string[]): boolean {
  return selected.length >= 2
    && selected.length <= MAX_COMBINE_SELECTION
    && new Set(selected).size === selected.length;
}

export function reorderCombineSelection(
  selected: string[],
  movingId: string,
  targetId: string,
): string[] {
  const from = selected.indexOf(movingId);
  const to = selected.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return selected;
  const next = selected.filter((candidate) => candidate !== movingId);
  next.splice(to, 0, movingId);
  return next;
}

export function selectFrameCapture(selected: string[], id: string): string[] {
  return selected.length === 1 && selected[0] === id ? [] : [id];
}

export type AnnotationProjectSyncEntry = {
  captureId: string;
  documentRevision: number;
  cloudRevision: number;
  status: "pending" | "uploading" | "failed" | "conflict" | "synced";
  lastError: string | null;
};

export type AnnotationProjectSyncStatus = {
  summary: {
    pending: number;
    uploading: number;
    failed: number;
    conflicts: number;
    synced: number;
    total: number;
  };
  warning: string | null;
  entries: AnnotationProjectSyncEntry[];
};

export type HistorySyncPresentation = {
  label: string;
  detail: string;
  tone: "muted" | "waiting" | "ready" | "attention";
  action: "retry" | "keep_local" | null;
};

export function historySyncPresentation(
  capture: LocalHistoryCapture,
  sync?: AnnotationProjectSyncEntry,
): HistorySyncPresentation {
  if (!capture.annotationRevision) {
    return {
      label: "Flattened capture",
      detail: "No editable project is stored for this capture.",
      tone: "muted",
      action: null,
    };
  }
  if (!sync) {
    return {
      label: "Local only",
      detail: `Editable revision ${capture.annotationRevision} is safe on this Mac.`,
      tone: "muted",
      action: null,
    };
  }
  if (sync.status === "pending") {
    return {
      label: "Waiting to sync",
      detail: `Editable revision ${sync.documentRevision} is queued with its protected original.`,
      tone: "waiting",
      action: null,
    };
  }
  if (sync.status === "uploading") {
    return {
      label: "Syncing…",
      detail: `Uploading editable revision ${sync.documentRevision}.`,
      tone: "waiting",
      action: null,
    };
  }
  if (sync.status === "synced") {
    return {
      label: `Cloud revision ${sync.cloudRevision}`,
      detail: `Editable revision ${sync.documentRevision} is backed up privately.`,
      tone: "ready",
      action: null,
    };
  }
  if (sync.status === "failed") {
    return {
      label: "Needs attention",
      detail: sync.lastError ?? "This editable project could not sync.",
      tone: "attention",
      action: "retry",
    };
  }
  return {
    label: `Conflict with cloud revision ${sync.cloudRevision}`,
    detail: sync.lastError ?? "Another Mac saved a newer editable revision.",
    tone: "attention",
    action: "keep_local",
  };
}

export function captureMonthKey(capture: LocalHistoryCapture): string {
  const date = new Date(capture.capturedAtMs);
  if (!Number.isFinite(date.getTime())) return "unknown";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function historyMonthOptions(captures: LocalHistoryCapture[]) {
  return [...new Set(captures.map(captureMonthKey))]
    .filter((key) => key !== "unknown")
    .sort((left, right) => right.localeCompare(left))
    .map((key) => {
      const [year, month] = key.split("-").map(Number);
      return {
        key,
        label: new Intl.DateTimeFormat("en-GB", {
          month: "long",
          year: "numeric",
        }).format(new Date(year, month - 1, 1)),
      };
    });
}

export function filterHistory(
  captures: LocalHistoryCapture[],
  month: string,
  source: HistoryCaptureFilter = "all",
  project: HistoryProjectFilter = "all",
  availableProjectIds: readonly string[] = [],
): LocalHistoryCapture[] {
  if (month === "all" && source === "all" && project === "all") return captures;
  const availableProjects = new Set(availableProjectIds);
  return captures.filter((capture) => (
    (month === "all" || captureMonthKey(capture) === month)
    && (source === "all" || (source === "unknown" ? capture.source === undefined : capture.source === source))
    && (
      project === "all"
      || (project === "unfiled" && capture.projectId === undefined)
      || (
        project === "unavailable"
        && capture.projectId !== undefined
        && !availableProjects.has(capture.projectId)
      )
      || capture.projectId === project
    )
  ));
}

export function historyProjectOptions(
  captures: LocalHistoryCapture[],
  projects: HistoryProject[],
): Array<{ key: string; label: string }> {
  const knownIds = new Set(projects.map((project) => project.id));
  const options = projects
    .map((project) => ({ key: project.id, label: project.name }))
    .sort((left, right) => left.label.localeCompare(right.label) || left.key.localeCompare(right.key));
  if (captures.some((capture) => capture.projectId && !knownIds.has(capture.projectId))) {
    options.push({ key: "unavailable", label: "Project name unavailable" });
  }
  return options;
}

export function historyProjectLabel(
  capture: LocalHistoryCapture,
  projects: HistoryProject[],
): string {
  if (!capture.projectId) return "Unfiled";
  return projects.find((project) => project.id === capture.projectId)?.name
    ?? "Project name unavailable";
}

export function historyCaptureKindLabel(source: HistoryCaptureSource | undefined): string {
  switch (source) {
    case "region": return "Area";
    case "window": return "Window";
    case "fullscreen": return "Full screen";
    case "created": return "Created in Capso";
    case "browser": return "Browser extension";
    case "recovered": return "Recovered";
    default: return "Unknown source";
  }
}

export function captureTimeLabel(capturedAtMs: number): string {
  const date = new Date(capturedAtMs);
  if (!Number.isFinite(date.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function captureSizeLabel(bytes: number): string {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return "Size unavailable";
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.round(bytes / 1_024)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
