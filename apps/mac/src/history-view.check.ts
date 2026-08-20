import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  captureMonthKey,
  captureSizeLabel,
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
  type AnnotationProjectSyncEntry,
  type LocalHistoryCapture,
} from "./history-view.ts";

const FIRST_PROJECT_ID = "018f22c4-cada-7c6b-9d5b-fc35f7f92276";
const SECOND_PROJECT_ID = "018f22c4-cada-7c6b-9d5b-fc35f7f92277";
const ARCHIVED_PROJECT_ID = "018f22c4-cada-7c6b-9d5b-fc35f7f92278";

const captures: LocalHistoryCapture[] = [
  { id: "a", path: "/a.png", capturedAtMs: new Date(2026, 7, 12, 10).getTime(), bytes: 900, source: "region" },
  { id: "b", path: "/b.png", capturedAtMs: new Date(2026, 7, 1, 10).getTime(), bytes: 2_048, source: "window" },
  { id: "c", path: "/c.png", capturedAtMs: new Date(2026, 6, 30, 10).getTime(), bytes: 1_572_864, source: "created" },
];

test("history month filters are local-time stable, newest first and never fabricate groups", () => {
  assert.equal(captureMonthKey(captures[0]), "2026-08");
  assert.deepEqual(historyMonthOptions(captures).map((option) => option.key), ["2026-08", "2026-07"]);
  assert.deepEqual(filterHistory(captures, "2026-08", "all").map((capture) => capture.id), ["a", "b"]);
  assert.deepEqual(filterHistory(captures, "2025-01", "all"), []);
  assert.equal(filterHistory(captures, "all", "all"), captures);
});

test("history type filters keep honest capture provenance including created and recovered files", () => {
  const withEveryKind: LocalHistoryCapture[] = [
    ...captures,
    { id: "d", path: "/d.png", capturedAtMs: 4, bytes: 4, source: "fullscreen" },
    { id: "e", path: "/e.png", capturedAtMs: 3, bytes: 3, source: "recovered" },
    { id: "g", path: "/g.png", capturedAtMs: 2, bytes: 5, source: "browser" },
    { id: "f", path: "/f.png", capturedAtMs: 2, bytes: 2 },
  ];
  assert.deepEqual(filterHistory(withEveryKind, "all", "window").map((capture) => capture.id), ["b"]);
  assert.deepEqual(filterHistory(withEveryKind, "all", "created").map((capture) => capture.id), ["c"]);
  assert.deepEqual(filterHistory(withEveryKind, "all", "recovered").map((capture) => capture.id), ["e"]);
  assert.deepEqual(filterHistory(withEveryKind, "all", "browser").map((capture) => capture.id), ["g"]);
  assert.deepEqual(filterHistory(withEveryKind, "all", "unknown").map((capture) => capture.id), ["f"]);
  assert.equal(historyCaptureKindLabel("region"), "Area");
  assert.equal(historyCaptureKindLabel("fullscreen"), "Full screen");
  assert.equal(historyCaptureKindLabel("browser"), "Browser extension");
  assert.equal(historyCaptureKindLabel(undefined), "Unknown source");
});

test("History composes project, source and month filters without losing unfiled captures", () => {
  const organised: LocalHistoryCapture[] = [
    { ...captures[0], projectId: FIRST_PROJECT_ID },
    { ...captures[1], projectId: SECOND_PROJECT_ID },
    { ...captures[2] },
    { id: "d", path: "/d.png", capturedAtMs: captures[0].capturedAtMs, bytes: 4, source: "browser", projectId: FIRST_PROJECT_ID },
    { id: "e", path: "/e.png", capturedAtMs: captures[0].capturedAtMs, bytes: 5, source: "browser", projectId: ARCHIVED_PROJECT_ID },
  ];
  const activeProjectIds = [FIRST_PROJECT_ID, SECOND_PROJECT_ID];

  assert.deepEqual(
    filterHistory(organised, "all", "all", FIRST_PROJECT_ID, activeProjectIds).map((capture) => capture.id),
    ["a", "d"],
  );
  assert.deepEqual(
    filterHistory(organised, "2026-08", "browser", FIRST_PROJECT_ID, activeProjectIds).map((capture) => capture.id),
    ["d"],
  );
  assert.deepEqual(
    filterHistory(organised, "all", "all", "unfiled", activeProjectIds).map((capture) => capture.id),
    ["c"],
  );
  assert.deepEqual(
    filterHistory(organised, "all", "all", "unavailable", activeProjectIds).map((capture) => capture.id),
    ["e"],
  );
});

test("History offers only relevant named projects and labels unavailable names honestly", () => {
  const organised: LocalHistoryCapture[] = [
    { ...captures[0], projectId: SECOND_PROJECT_ID },
    { ...captures[1], projectId: FIRST_PROJECT_ID },
    { ...captures[2], projectId: ARCHIVED_PROJECT_ID },
  ];
  const projects = [
    { id: FIRST_PROJECT_ID, name: "Launch research" },
    { id: SECOND_PROJECT_ID, name: "Client clips" },
  ];

  assert.deepEqual(historyProjectOptions(organised, projects), [
    { key: SECOND_PROJECT_ID, label: "Client clips" },
    { key: FIRST_PROJECT_ID, label: "Launch research" },
    { key: "unavailable", label: "Project name unavailable" },
  ]);
  assert.equal(historyProjectLabel(organised[0], projects), "Client clips");
  assert.equal(historyProjectLabel(organised[2], projects), "Project name unavailable");
  assert.equal(historyProjectLabel(captures[0], projects), "Unfiled");
});

test("History loads project names without making an unavailable account block local captures", async () => {
  const view = await readFile(new URL("./HistoryView.tsx", import.meta.url), "utf8");

  assert.match(view, /get_capture_projects/);
  assert.match(view, /aria-label="Capture project"/);
  assert.match(view, /Project names are unavailable\. Assignments remain safe/);
  assert.match(view, /historyProjectLabel\(capture, projects\)/);
});

test("history sizes stay compact without claiming invalid metadata", () => {
  assert.equal(captureSizeLabel(900), "900 B");
  assert.equal(captureSizeLabel(2_048), "2 KB");
  assert.equal(captureSizeLabel(1_572_864), "1.5 MB");
  assert.equal(captureSizeLabel(0), "Size unavailable");
});

test("History distinguishes active library downloads from a paused mirror", () => {
  assert.deepEqual(historyLibraryMirrorPresentation(2, null), {
    title: "Downloading 2 captures to this Mac",
    message: "They will appear here automatically. You can keep working.",
    tone: "progress",
    action: null,
  });
  assert.deepEqual(historyLibraryMirrorPresentation(1, "offline fixture"), {
    title: "Library download paused",
    message: "Your cloud library remains private and unchanged.",
    tone: "warning",
    action: "retry",
  });
  assert.equal(historyLibraryMirrorPresentation(0, null), null);
});

test("history card pointer double-click never races its single-click Quick Access action", () => {
  assert.equal(historyCardClickAction(0), "open_now", "keyboard activation stays immediate");
  assert.equal(historyCardClickAction(1), "wait_for_double_click");
  assert.equal(historyCardClickAction(2), "cancel_pending_open");
  assert.equal(historyCardClickAction(3), "cancel_pending_open");
});

test("preview History removal and Undo preserve exact captures, counts and newest-first order", () => {
  const snapshot = { captures, total: 3, removed: 0, truncated: false };
  const hidden = removeHistoryPreview(snapshot, ["a", "c"]);
  assert.deepEqual(hidden.captures.map((capture) => capture.id), ["b"]);
  assert.equal(hidden.total, 1);
  assert.equal(hidden.removed, 2);
  assert.equal(snapshot.total, 3, "the source snapshot stays immutable");

  const restored = restoreHistoryPreview(hidden, [captures[0], captures[2]]);
  assert.deepEqual(restored.captures.map((capture) => capture.id), ["a", "b", "c"]);
  assert.equal(restored.total, 3);
  assert.equal(restored.removed, 0);
  assert.equal(restoreHistoryPreview(restored, [captures[0]]), restored, "duplicate Undo is a no-op");
});

test("combine selection is ordered, unique, and bounded to eight captures", () => {
  const first = toggleCombineSelection([], "a");
  const second = toggleCombineSelection(first, "b");
  assert.deepEqual(second, ["a", "b"]);
  assert.deepEqual(toggleCombineSelection(second, "a"), ["b"]);

  const full = ["a", "b", "c", "d", "e", "f", "g", "h"];
  assert.equal(toggleCombineSelection(full, "i"), full);
  assert.deepEqual(toggleCombineSelection(full, "d"), ["a", "b", "c", "e", "f", "g", "h"]);
  assert.equal(canCombineSelection(["a"]), false);
  assert.equal(canCombineSelection(["a", "b"]), true);
  assert.equal(canCombineSelection(full), true);
  assert.equal(canCombineSelection([...full, "i"]), false);
});

test("combine reorder is deterministic and ignores stale drag identifiers", () => {
  const selected = ["a", "b", "c", "d"];
  assert.deepEqual(reorderCombineSelection(selected, "d", "b"), ["a", "d", "b", "c"]);
  assert.deepEqual(reorderCombineSelection(selected, "a", "d"), ["b", "c", "d", "a"]);
  assert.equal(reorderCombineSelection(selected, "missing", "b"), selected);
  assert.equal(reorderCombineSelection(selected, "b", "missing"), selected);
  assert.equal(reorderCombineSelection(selected, "b", "b"), selected);
});

test("social framing owns exactly one reversible source selection", () => {
  assert.deepEqual(selectFrameCapture([], "a"), ["a"]);
  assert.deepEqual(selectFrameCapture(["a"], "b"), ["b"]);
  assert.deepEqual(selectFrameCapture(["a"], "a"), []);
});

const editable: LocalHistoryCapture = {
  id: "a",
  path: "/a.png",
  capturedAtMs: new Date(2026, 7, 12, 10).getTime(),
  bytes: 900,
  annotationRevision: 3,
};

function projectSync(
  status: AnnotationProjectSyncEntry["status"],
  cloudRevision = 2,
  lastError: string | null = null,
): AnnotationProjectSyncEntry {
  return {
    captureId: editable.id,
    documentRevision: 3,
    cloudRevision,
    status,
    lastError,
  };
}

test("history keeps local, waiting, cloud, failure, and conflict project states distinct", () => {
  assert.deepEqual(historySyncPresentation(editable), {
    label: "Local only",
    detail: "Editable revision 3 is safe on this Mac.",
    tone: "muted",
    action: null,
  });
  assert.deepEqual(historySyncPresentation(editable, projectSync("pending")), {
    label: "Waiting to sync",
    detail: "Editable revision 3 is queued with its protected original.",
    tone: "waiting",
    action: null,
  });
  assert.deepEqual(historySyncPresentation(editable, projectSync("uploading")), {
    label: "Syncing…",
    detail: "Uploading editable revision 3.",
    tone: "waiting",
    action: null,
  });
  assert.deepEqual(historySyncPresentation(editable, projectSync("synced", 2)), {
    label: "Cloud revision 2",
    detail: "Editable revision 3 is backed up privately.",
    tone: "ready",
    action: null,
  });
  assert.deepEqual(
    historySyncPresentation(editable, projectSync("failed", 2, "Protected original is missing.")),
    {
      label: "Needs attention",
      detail: "Protected original is missing.",
      tone: "attention",
      action: "retry",
    },
  );
  assert.deepEqual(
    historySyncPresentation(editable, projectSync("conflict", 4, "Another Mac saved revision 4.")),
    {
      label: "Conflict with cloud revision 4",
      detail: "Another Mac saved revision 4.",
      tone: "attention",
      action: "keep_local",
    },
  );
});

test("flattened captures never pretend to have editable cloud state", () => {
  assert.deepEqual(historySyncPresentation(captures[0], projectSync("synced", 9)), {
    label: "Flattened capture",
    detail: "No editable project is stored for this capture.",
    tone: "muted",
    action: null,
  });
});
