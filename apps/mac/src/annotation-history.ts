import {
  DEFAULT_IMAGE_SCALE,
  DEFAULT_IMAGE_TRANSFORM,
  nextCounterValue,
  translate,
  type AnnotationCrop,
  type ImageTransform,
  type Mark,
} from "@capso/shared/annotate";

function cloneMark(mark: Mark): Mark {
  return mark.kind === "pencil" || mark.kind === "highlighter"
    ? { ...mark, points: mark.points.map((point) => ({ ...point })) }
    : { ...mark };
}

export function copySelectedMark(marks: Mark[], selected: number): Mark | null {
  const mark = marks[selected];
  return mark ? cloneMark(mark) : null;
}

export function pasteCopiedMark(
  mark: Mark,
  marks: Mark[],
  pasteCount: number,
): Mark | null {
  if (mark.kind === "spotlight" && marks.some((candidate) => candidate.kind === "spotlight")) {
    return null;
  }
  const boundedCount = Math.min(8, Math.max(1, Math.floor(pasteCount)));
  return translate(cloneMark(mark), boundedCount * 16, boundedCount * 16);
}

export function duplicateSelectedMark(
  marks: Mark[],
  selected: number,
  counterStart: number,
): Mark | null {
  const mark = marks[selected];
  if (!mark || mark.kind === "spotlight") return null;
  const copy = cloneMark(mark);
  return copy.kind === "counter"
    ? { ...copy, value: nextCounterValue(marks, counterStart) }
    : copy;
}

export type AnnotationOperation =
  | { kind: "add"; index: number; mark: Mark }
  | { kind: "delete"; index: number; mark: Mark }
  | { kind: "reorder"; from: number; to: number }
  | { kind: "update"; index: number; before: Mark; after: Mark }
  | { kind: "erase"; before: Mark[]; after: Mark[] }
  | { kind: "transform"; before: ImageTransform; after: ImageTransform }
  | { kind: "resize"; before: number; after: number }
  | { kind: "crop"; before: AnnotationCrop | null; after: AnnotationCrop | null };

export type AnnotationEditState = {
  marks: Mark[];
  crop: AnnotationCrop | null;
  imageTransform: ImageTransform;
  imageScale: number;
  undo: AnnotationOperation[];
  redo: AnnotationOperation[];
};

export type AnnotationEditAction =
  | { type: "add"; mark: Mark }
  | { type: "delete"; index: number }
  | { type: "reorder"; from: number; to: number }
  | { type: "update"; index: number; before: Mark; after: Mark }
  | { type: "preview_move"; index: number; mark: Mark }
  | { type: "commit_move"; index: number; before: Mark; after: Mark }
  | { type: "erase"; marks: Mark[] }
  | { type: "transform"; imageTransform: ImageTransform }
  | { type: "resize"; imageScale: number }
  | { type: "crop"; crop: AnnotationCrop | null }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "reset" };

export const EMPTY_ANNOTATION_EDIT_STATE: AnnotationEditState = {
  marks: [],
  crop: null,
  imageTransform: DEFAULT_IMAGE_TRANSFORM,
  imageScale: DEFAULT_IMAGE_SCALE,
  undo: [],
  redo: [],
};

function insertAt(marks: Mark[], index: number, mark: Mark) {
  return [...marks.slice(0, index), mark, ...marks.slice(index)];
}

function replaceAt(marks: Mark[], index: number, mark: Mark) {
  return marks.map((current, currentIndex) => currentIndex === index ? mark : current);
}

function reorderAt(marks: Mark[], from: number, to: number) {
  if (!marks[from] || from === to || to < 0 || to >= marks.length) return marks;
  const next = [...marks];
  const [mark] = next.splice(from, 1);
  next.splice(to, 0, mark!);
  return next;
}

function applyOperation(marks: Mark[], operation: AnnotationOperation): Mark[] {
  if (operation.kind === "crop" || operation.kind === "transform" || operation.kind === "resize") return marks;
  if (operation.kind === "erase") return operation.after;
  if (operation.kind === "add") return insertAt(marks, operation.index, operation.mark);
  if (operation.kind === "delete") return marks.filter((_, index) => index !== operation.index);
  if (operation.kind === "reorder") return reorderAt(marks, operation.from, operation.to);
  return replaceAt(marks, operation.index, operation.after);
}

function reverseOperation(marks: Mark[], operation: AnnotationOperation): Mark[] {
  if (operation.kind === "crop" || operation.kind === "transform" || operation.kind === "resize") return marks;
  if (operation.kind === "erase") return operation.before;
  if (operation.kind === "add") return marks.filter((_, index) => index !== operation.index);
  if (operation.kind === "delete") return insertAt(marks, operation.index, operation.mark);
  if (operation.kind === "reorder") return reorderAt(marks, operation.to, operation.from);
  return replaceAt(marks, operation.index, operation.before);
}

function sameMark(left: Mark, right: Mark) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function indexAfterReorder(index: number, from: number, to: number) {
  if (index === from) return to;
  if (from < to && index > from && index <= to) return index - 1;
  if (to < from && index >= to && index < from) return index + 1;
  return index;
}

export function selectionAfterApply(
  selected: number | null,
  operation: AnnotationOperation | undefined,
): number | null {
  if (selected === null || !operation || operation.kind === "update" || operation.kind === "crop" || operation.kind === "transform" || operation.kind === "resize") return selected;
  if (operation.kind === "erase") return null;
  if (operation.kind === "add") return selected >= operation.index ? selected + 1 : selected;
  if (operation.kind === "delete") {
    if (selected === operation.index) return null;
    return selected > operation.index ? selected - 1 : selected;
  }
  return indexAfterReorder(selected, operation.from, operation.to);
}

export function selectionAfterReverse(
  selected: number | null,
  operation: AnnotationOperation | undefined,
): number | null {
  if (selected === null || !operation || operation.kind === "update" || operation.kind === "crop" || operation.kind === "transform" || operation.kind === "resize") return selected;
  if (operation.kind === "erase") return null;
  if (operation.kind === "add") {
    if (selected === operation.index) return null;
    return selected > operation.index ? selected - 1 : selected;
  }
  if (operation.kind === "delete") return selected >= operation.index ? selected + 1 : selected;
  return indexAfterReorder(selected, operation.to, operation.from);
}

export function annotationEditReducer(
  state: AnnotationEditState,
  action: AnnotationEditAction,
): AnnotationEditState {
  if (action.type === "reset") return EMPTY_ANNOTATION_EDIT_STATE;
  if (action.type === "resize") {
    if (state.imageScale === action.imageScale) return state;
    const operation: AnnotationOperation = {
      kind: "resize",
      before: state.imageScale,
      after: action.imageScale,
    };
    return {
      ...state,
      imageScale: action.imageScale,
      undo: [...state.undo, operation],
      redo: [],
    };
  }
  if (action.type === "transform") {
    if (JSON.stringify(state.imageTransform) === JSON.stringify(action.imageTransform)) return state;
    const operation: AnnotationOperation = {
      kind: "transform",
      before: state.imageTransform,
      after: action.imageTransform,
    };
    return {
      ...state,
      imageTransform: action.imageTransform,
      undo: [...state.undo, operation],
      redo: [],
    };
  }
  if (action.type === "erase") {
    if (JSON.stringify(state.marks) === JSON.stringify(action.marks)) return state;
    const operation: AnnotationOperation = { kind: "erase", before: state.marks, after: action.marks };
    return {
      marks: action.marks,
      crop: state.crop,
      imageTransform: state.imageTransform,
      imageScale: state.imageScale,
      undo: [...state.undo, operation],
      redo: [],
    };
  }
  if (action.type === "crop") {
    if (JSON.stringify(state.crop) === JSON.stringify(action.crop)) return state;
    const operation: AnnotationOperation = { kind: "crop", before: state.crop, after: action.crop };
    return {
      marks: state.marks,
      crop: action.crop,
      imageTransform: state.imageTransform,
      imageScale: state.imageScale,
      undo: [...state.undo, operation],
      redo: [],
    };
  }
  if (action.type === "add") {
    const operation: AnnotationOperation = {
      kind: "add",
      index: state.marks.length,
      mark: action.mark,
    };
    return {
      marks: applyOperation(state.marks, operation),
      crop: state.crop,
      imageTransform: state.imageTransform,
      imageScale: state.imageScale,
      undo: [...state.undo, operation],
      redo: [],
    };
  }
  if (action.type === "delete") {
    const mark = state.marks[action.index];
    if (!mark) return state;
    const operation: AnnotationOperation = { kind: "delete", index: action.index, mark };
    return {
      marks: applyOperation(state.marks, operation),
      crop: state.crop,
      imageTransform: state.imageTransform,
      imageScale: state.imageScale,
      undo: [...state.undo, operation],
      redo: [],
    };
  }
  if (action.type === "reorder") {
    if (!state.marks[action.from] || action.from === action.to || action.to < 0 || action.to >= state.marks.length) {
      return state;
    }
    const operation: AnnotationOperation = { kind: "reorder", from: action.from, to: action.to };
    return {
      marks: applyOperation(state.marks, operation),
      crop: state.crop,
      imageTransform: state.imageTransform,
      imageScale: state.imageScale,
      undo: [...state.undo, operation],
      redo: [],
    };
  }
  if (action.type === "update") {
    if (!state.marks[action.index] || sameMark(action.before, action.after)) return state;
    const operation: AnnotationOperation = {
      kind: "update",
      index: action.index,
      before: action.before,
      after: action.after,
    };
    return {
      marks: applyOperation(state.marks, operation),
      crop: state.crop,
      imageTransform: state.imageTransform,
      imageScale: state.imageScale,
      undo: [...state.undo, operation],
      redo: [],
    };
  }
  if (action.type === "preview_move") {
    if (!state.marks[action.index]) return state;
    return { ...state, marks: replaceAt(state.marks, action.index, action.mark) };
  }
  if (action.type === "commit_move") {
    if (!state.marks[action.index] || sameMark(action.before, action.after)) return state;
    const operation: AnnotationOperation = {
      kind: "update",
      index: action.index,
      before: action.before,
      after: action.after,
    };
    return { ...state, undo: [...state.undo, operation], redo: [] };
  }
  if (action.type === "undo") {
    const operation = state.undo.at(-1);
    if (!operation) return state;
    return {
      marks: reverseOperation(state.marks, operation),
      crop: operation.kind === "crop" ? operation.before : state.crop,
      imageTransform: operation.kind === "transform" ? operation.before : state.imageTransform,
      imageScale: operation.kind === "resize" ? operation.before : state.imageScale,
      undo: state.undo.slice(0, -1),
      redo: [...state.redo, operation],
    };
  }
  const operation = state.redo.at(-1);
  if (!operation) return state;
  return {
    marks: applyOperation(state.marks, operation),
    crop: operation.kind === "crop" ? operation.after : state.crop,
    imageTransform: operation.kind === "transform" ? operation.after : state.imageTransform,
    imageScale: operation.kind === "resize" ? operation.after : state.imageScale,
    undo: [...state.undo, operation],
    redo: state.redo.slice(0, -1),
  };
}
