import assert from "node:assert/strict";
import test from "node:test";
import {
  annotationEditReducer,
  copySelectedMark,
  duplicateSelectedMark,
  EMPTY_ANNOTATION_EDIT_STATE,
  pasteCopiedMark,
  selectionAfterApply,
  selectionAfterReverse,
  type AnnotationOperation,
  type AnnotationEditState,
} from "./annotation-history.ts";
import type { Mark } from "@capso/shared/annotate";

const line = (x1: number): Extract<Mark, { kind: "line" }> => ({
  kind: "line",
  color: "currentColor",
  x1,
  y1: 10,
  x2: x1 + 40,
  y2: 50,
});

function reduce(state: AnnotationEditState, ...actions: Parameters<typeof annotationEditReducer>[1][]) {
  return actions.reduce(annotationEditReducer, state);
}

test("additions undo and redo without losing their exact order", () => {
  const first = line(10);
  const second = line(70);
  const edited = reduce(EMPTY_ANNOTATION_EDIT_STATE, { type: "add", mark: first }, { type: "add", mark: second });
  const undone = annotationEditReducer(edited, { type: "undo" });
  assert.deepEqual(undone.marks, [first]);
  assert.deepEqual(annotationEditReducer(undone, { type: "redo" }).marks, [first, second]);
});

test("keyboard duplicate copies one selected mark while keeping Counter and Spotlight rules exact", () => {
  const counter: Mark = { kind: "counter", color: "red", x: 40, y: 50, value: 4, size: 32 };
  const lineMark = line(70);
  const spotlight: Mark = { kind: "spotlight", x: 10, y: 20, w: 100, h: 60 };
  const marks = [counter, lineMark, { ...counter, value: 7 }, spotlight];

  assert.deepEqual(duplicateSelectedMark(marks, 1, 1), lineMark);
  assert.notEqual(duplicateSelectedMark(marks, 1, 1), lineMark);
  assert.deepEqual(duplicateSelectedMark(marks, 0, 1), { ...counter, value: 8 });
  assert.equal(duplicateSelectedMark(marks, 3, 1), null);
  assert.equal(duplicateSelectedMark(marks, 99, 1), null);
  const pencil: Extract<Mark, { kind: "pencil" }> = {
    kind: "pencil",
    color: "blue",
    points: [{ x: 10, y: 20 }, { x: 30, y: 40 }],
  };
  const pencilCopy = duplicateSelectedMark([pencil], 0, 1)! as typeof pencil;
  assert.deepEqual(pencilCopy, pencil);
  assert.notEqual(pencilCopy.points, pencil.points, "freehand copies must own their point payload");

  const copy = duplicateSelectedMark(marks, 1, 1)!;
  const initial: AnnotationEditState = {
    marks,
    crop: null,
    imageTransform: { quarterTurns: 0, flipped: false },
    imageScale: 1,
    undo: [],
    redo: [],
  };
  const duplicated = annotationEditReducer(initial, { type: "add", mark: copy });
  assert.deepEqual(duplicated.marks, [...marks, lineMark]);
  assert.deepEqual(annotationEditReducer(duplicated, { type: "undo" }).marks, marks);
});

test("object clipboard owns its payload, offsets each paste and keeps Spotlight single", () => {
  const pencil: Extract<Mark, { kind: "pencil" }> = {
    kind: "pencil",
    color: "blue",
    points: [{ x: 10, y: 20 }, { x: 30, y: 40 }],
  };
  const copied = copySelectedMark([pencil], 0)! as typeof pencil;
  assert.deepEqual(copied, pencil);
  assert.notEqual(copied, pencil);
  assert.notEqual(copied.points, pencil.points);

  const firstPaste = pasteCopiedMark(copied, [], 1)! as typeof pencil;
  const secondPaste = pasteCopiedMark(copied, [firstPaste], 2)! as typeof pencil;
  assert.deepEqual(firstPaste.points, [{ x: 26, y: 36 }, { x: 46, y: 56 }]);
  assert.deepEqual(secondPaste.points, [{ x: 42, y: 52 }, { x: 62, y: 72 }]);
  assert.notEqual(firstPaste.points, copied.points);

  const spotlight: Mark = { kind: "spotlight", x: 10, y: 20, w: 100, h: 60 };
  const copiedSpotlight = copySelectedMark([spotlight], 0)!;
  assert.equal(pasteCopiedMark(copiedSpotlight, [spotlight], 1), null);
  assert.deepEqual(pasteCopiedMark(copiedSpotlight, [], 1), {
    ...spotlight,
    x: 26,
    y: 36,
  });

  const initial = annotationEditReducer(EMPTY_ANNOTATION_EDIT_STATE, { type: "add", mark: pencil });
  const pasted = annotationEditReducer(initial, { type: "add", mark: firstPaste });
  assert.deepEqual(annotationEditReducer(pasted, { type: "undo" }).marks, [pencil]);
});

test("deleting a middle mark restores it at the same stacking index", () => {
  const marks = [line(10), line(70), line(130)];
  const edited = marks.reduce(
    (state, mark) => annotationEditReducer(state, { type: "add", mark }),
    EMPTY_ANNOTATION_EDIT_STATE,
  );
  const deleted = annotationEditReducer(edited, { type: "delete", index: 1 });
  assert.deepEqual(deleted.marks, [marks[0], marks[2]]);
  assert.deepEqual(annotationEditReducer(deleted, { type: "undo" }).marks, marks);
});

test("many pointer previews commit as one reversible move", () => {
  const before = line(10);
  const middle = line(20);
  const after = line(30);
  let state = annotationEditReducer(EMPTY_ANNOTATION_EDIT_STATE, { type: "add", mark: before });
  state = annotationEditReducer(state, { type: "preview_move", index: 0, mark: middle });
  state = annotationEditReducer(state, { type: "preview_move", index: 0, mark: after });
  state = annotationEditReducer(state, { type: "commit_move", index: 0, before, after });
  assert.equal(state.undo.length, 2);
  assert.deepEqual(annotationEditReducer(state, { type: "undo" }).marks, [before]);
});

test("a new edit after undo clears the abandoned redo branch", () => {
  const edited = reduce(EMPTY_ANNOTATION_EDIT_STATE, { type: "add", mark: line(10) }, { type: "undo" });
  assert.equal(edited.redo.length, 1);
  const branched = annotationEditReducer(edited, { type: "add", mark: line(90) });
  assert.equal(branched.redo.length, 0);
  assert.deepEqual(annotationEditReducer(branched, { type: "redo" }), branched);
});

test("undo and redo preserve the exact flattened style payload", () => {
  const styled: Mark = { ...line(10), strokeWeight: "bold" };
  const added = annotationEditReducer(EMPTY_ANNOTATION_EDIT_STATE, { type: "add", mark: styled });
  const undone = annotationEditReducer(added, { type: "undo" });
  assert.deepEqual(annotationEditReducer(undone, { type: "redo" }).marks, [styled]);
});

test("a keyboard nudge is one reversible move operation", () => {
  const before = line(10);
  const after = line(20);
  const added = annotationEditReducer(EMPTY_ANNOTATION_EDIT_STATE, { type: "add", mark: before });
  const moved = annotationEditReducer(added, { type: "update", index: 0, before, after });
  assert.deepEqual(moved.marks, [after]);
  const undone = annotationEditReducer(moved, { type: "undo" });
  assert.deepEqual(undone.marks, [before]);
  assert.deepEqual(annotationEditReducer(undone, { type: "redo" }).marks, [after]);
});

test("spotlight resize, strength and shape changes are exact reversible operations", () => {
  const before: Mark = { kind: "spotlight", x: 10, y: 20, w: 100, h: 60, strength: "regular" };
  const resized: Mark = { ...before, x: 5, y: 8, w: 105, h: 72 };
  const strong: Mark = { ...resized, strength: "strong" };
  const ellipse: Mark = { ...strong, spotlightShape: "ellipse" };
  let state = annotationEditReducer(EMPTY_ANNOTATION_EDIT_STATE, { type: "add", mark: before });
  state = annotationEditReducer(state, { type: "preview_move", index: 0, mark: resized });
  state = annotationEditReducer(state, { type: "commit_move", index: 0, before, after: resized });
  state = annotationEditReducer(state, { type: "update", index: 0, before: resized, after: strong });
  state = annotationEditReducer(state, { type: "update", index: 0, before: strong, after: ellipse });
  assert.deepEqual(state.marks, [ellipse]);
  state = annotationEditReducer(state, { type: "undo" });
  assert.deepEqual(state.marks, [strong]);
  state = annotationEditReducer(state, { type: "undo" });
  assert.deepEqual(state.marks, [resized]);
  state = annotationEditReducer(state, { type: "undo" });
  assert.deepEqual(state.marks, [before]);
  assert.deepEqual(annotationEditReducer(state, { type: "redo" }).marks, [resized]);
});

test("blur mode and intensity changes are exact reversible operations", () => {
  const before: Mark = {
    kind: "blur_effect",
    x: 10,
    y: 20,
    w: 100,
    h: 60,
    blurMode: "secure",
    blurStrength: "regular",
  };
  const after: Mark = { ...before, blurMode: "smooth", blurStrength: "strong" };
  const initial: AnnotationEditState = {
    marks: [before],
    crop: null,
    imageTransform: { quarterTurns: 0, flipped: false },
    imageScale: 1,
    undo: [],
    redo: [],
  };
  const changed = annotationEditReducer(initial, { type: "update", index: 0, before, after });
  assert.deepEqual(changed.marks, [after]);
  assert.deepEqual(annotationEditReducer(changed, { type: "undo" }).marks, [before]);
  assert.deepEqual(
    annotationEditReducer(annotationEditReducer(changed, { type: "undo" }), { type: "redo" }).marks,
    [after],
  );
});

test("an eraser gesture replaces all affected stroke fragments as one undo step", () => {
  const before: Mark[] = [
    { kind: "pencil", color: "red", points: [{ x: 0, y: 10 }, { x: 20, y: 10 }, { x: 40, y: 10 }] },
    line(70),
  ];
  const after: Mark[] = [line(70)];
  const initial: AnnotationEditState = {
    marks: before,
    crop: null,
    imageTransform: { quarterTurns: 0, flipped: false },
    imageScale: 1,
    undo: [],
    redo: [],
  };

  const erased = annotationEditReducer(initial, { type: "erase", marks: after });

  assert.deepEqual(erased.marks, after);
  assert.equal(erased.undo.length, 1);
  assert.deepEqual(annotationEditReducer(erased, { type: "undo" }).marks, before);
  assert.deepEqual(
    annotationEditReducer(annotationEditReducer(erased, { type: "undo" }), { type: "redo" }).marks,
    after,
  );
  assert.equal(
    annotationEditReducer(initial, { type: "erase", marks: before }),
    initial,
    "a missed eraser gesture must not create fake history",
  );
});

test("image orientation is one reversible operation without rewriting source-space marks", () => {
  const initial: AnnotationEditState = {
    marks: [line(10)],
    crop: null,
    imageTransform: { quarterTurns: 0, flipped: false },
    imageScale: 1,
    undo: [],
    redo: [],
  };
  const rotated = annotationEditReducer(initial, {
    type: "transform",
    imageTransform: { quarterTurns: 1, flipped: false },
  });
  assert.deepEqual(rotated.marks, initial.marks);
  assert.deepEqual(rotated.imageTransform, { quarterTurns: 1, flipped: false });
  const undone = annotationEditReducer(rotated, { type: "undo" });
  assert.deepEqual(undone.imageTransform, initial.imageTransform);
  assert.deepEqual(annotationEditReducer(undone, { type: "redo" }).imageTransform, rotated.imageTransform);
});

test("output resolution is one reversible operation independent from source-space geometry", () => {
  const original = annotationEditReducer(EMPTY_ANNOTATION_EDIT_STATE, { type: "add", mark: line(10) });
  const resized = annotationEditReducer(original, { type: "resize", imageScale: 0.5 });
  assert.equal(resized.imageScale, 0.5);
  assert.deepEqual(resized.marks, original.marks);
  const undone = annotationEditReducer(resized, { type: "undo" });
  assert.equal(undone.imageScale, 1);
  assert.deepEqual(undone.marks, original.marks);
  assert.equal(annotationEditReducer(undone, { type: "redo" }).imageScale, 0.5);
});

test("layer reordering preserves payloads and reverses exact stacking positions", () => {
  const marks = [line(10), line(70), line(130)];
  let state = marks.reduce(
    (current, mark) => annotationEditReducer(current, { type: "add", mark }),
    EMPTY_ANNOTATION_EDIT_STATE,
  );
  state = annotationEditReducer(state, { type: "reorder", from: 0, to: 2 });
  assert.deepEqual(state.marks, [marks[1], marks[2], marks[0]]);
  const undone = annotationEditReducer(state, { type: "undo" });
  assert.deepEqual(undone.marks, marks);
  assert.deepEqual(annotationEditReducer(undone, { type: "redo" }).marks, [marks[1], marks[2], marks[0]]);
  assert.equal(
    annotationEditReducer(state, { type: "reorder", from: 2, to: 2 }),
    state,
    "a boundary no-op must not create fake history",
  );
});

test("contextual counter color, size and style updates undo as one exact object replacement", () => {
  const before: Mark = { kind: "counter", color: "red", x: 40, y: 50, value: 1, size: 32 };
  const after: Mark = { ...before, color: "blue", size: 52, counterStyle: "outlined" };
  const added = annotationEditReducer(EMPTY_ANNOTATION_EDIT_STATE, { type: "add", mark: before });
  const styled = annotationEditReducer(added, { type: "update", index: 0, before, after });
  assert.deepEqual(styled.marks, [after]);
  const undone = annotationEditReducer(styled, { type: "undo" });
  assert.deepEqual(undone.marks, [before]);
  assert.deepEqual(annotationEditReducer(undone, { type: "redo" }).marks, [after]);
});

test("highlighter opacity changes preserve Smart geometry and undo exactly", () => {
  const before: Mark = {
    kind: "highlighter",
    color: "amber",
    points: [{ x: 10, y: 20 }, { x: 80, y: 20 }],
    smartWidth: 18,
  };
  const after: Mark = { ...before, highlighterOpacity: "strong" };
  const added = annotationEditReducer(EMPTY_ANNOTATION_EDIT_STATE, { type: "add", mark: before });
  const changed = annotationEditReducer(added, { type: "update", index: 0, before, after });
  assert.deepEqual(changed.marks, [after]);
  const undone = annotationEditReducer(changed, { type: "undo" });
  assert.deepEqual(undone.marks, [before]);
  assert.deepEqual(annotationEditReducer(undone, { type: "redo" }).marks, [after]);
});

test("post-creation text editing preserves every non-content style field", () => {
  const before: Mark = {
    kind: "text",
    color: "blue",
    x: 40,
    y: 50,
    text: "Draft",
    size: 32,
    textStyle: "rounded-boxed",
  };
  const after: Mark = { ...before, text: "Ready to share" };
  const added = annotationEditReducer(EMPTY_ANNOTATION_EDIT_STATE, { type: "add", mark: before });
  const edited = annotationEditReducer(added, { type: "update", index: 0, before, after });
  assert.deepEqual(edited.marks, [after]);
  const undone = annotationEditReducer(edited, { type: "undo" });
  assert.deepEqual(undone.marks, [before]);
  assert.deepEqual(annotationEditReducer(undone, { type: "redo" }).marks, [after]);
});

test("selection follows the same object through update and reorder history", () => {
  const update: AnnotationOperation = { kind: "update", index: 1, before: line(10), after: line(20) };
  assert.equal(selectionAfterApply(1, update), 1);
  assert.equal(selectionAfterReverse(1, update), 1);

  const reorder: AnnotationOperation = { kind: "reorder", from: 0, to: 2 };
  assert.equal(selectionAfterApply(0, reorder), 2);
  assert.equal(selectionAfterApply(1, reorder), 0);
  assert.equal(selectionAfterReverse(2, reorder), 0);
  assert.equal(selectionAfterReverse(0, reorder), 1);

  const add: AnnotationOperation = { kind: "add", index: 1, mark: line(10) };
  assert.equal(selectionAfterReverse(1, add), null);
  assert.equal(selectionAfterApply(1, add), 2);
  const remove: AnnotationOperation = { kind: "delete", index: 1, mark: line(10) };
  assert.equal(selectionAfterApply(1, remove), null);
  assert.equal(selectionAfterReverse(1, remove), 2);
});

test("crop revisions undo and redo without translating or deleting source-space marks", () => {
  const mark = line(70);
  const cropped = { x: 40, y: 30, w: 320, h: 180 };
  let state = annotationEditReducer(EMPTY_ANNOTATION_EDIT_STATE, { type: "add", mark });
  state = annotationEditReducer(state, { type: "crop", crop: cropped });
  assert.deepEqual(state.crop, cropped);
  assert.deepEqual(state.marks, [mark]);
  assert.equal(selectionAfterApply(0, state.undo.at(-1)), 0);
  state = annotationEditReducer(state, { type: "undo" });
  assert.equal(state.crop, null);
  assert.deepEqual(state.marks, [mark]);
  state = annotationEditReducer(state, { type: "redo" });
  assert.deepEqual(state.crop, cropped);
  state = annotationEditReducer(state, { type: "crop", crop: null });
  assert.equal(state.crop, null);
  assert.deepEqual(annotationEditReducer(state, { type: "undo" }).crop, cropped);
});
