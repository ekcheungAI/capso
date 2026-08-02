"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_COLOR, hitTest, isDegenerate, PALETTE, paintAll, paintSelection,
  rectFrom, redacts, textSizeFor, translate, type Mark, type Tool,
} from "@/lib/annotate";

/**
 * The quick annotation editor (05 §3, feature M2).
 *
 * Marks are vector objects while this is open and are flattened into the image
 * on save, exactly as the spec requires. Everything is stored in *image* pixel
 * coordinates rather than screen ones, so a mark lands where it was drawn no
 * matter how the canvas happened to be scaled to fit the window — the saved
 * file is the source of truth, not the preview.
 *
 * Four tools and nothing else. `04_MVP_SCOPE.md` lists a fuller annotation suite
 * as a tripwire, so the palette is five presets rather than a colour picker and
 * there is no crop, highlighter or counter.
 */
export function AnnotateEditor({
  src,
  onCancel,
  onSave,
}: {
  src: string;
  onCancel: () => void;
  onSave: (dataUrl: string, redacted: boolean) => void | Promise<void>;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const anchorRef = useRef<{ x: number; y: number } | null>(null);
  /**
   * The image's true pixel size, in state rather than read back off the canvas
   * ref. Render must not touch a ref — it is not a value React tracks, so a
   * component positioned from one can paint before the ref is set and never
   * correct itself.
   */
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [tool, setTool] = useState<Tool>("arrow");
  const [color, setColor] = useState<string>(DEFAULT_COLOR);
  const [marks, setMarks] = useState<Mark[]>([]);
  /**
   * The mark being dragged, held in a ref *and* mirrored into state.
   *
   * The ref is the truth the pointer handlers read; the state exists only to
   * trigger the repaint. Reading it from state instead makes the whole gesture
   * depend on React having flushed between `pointerdown` and the first
   * `pointermove` — true for ordinary input, which crosses frames, but not
   * something a drag should rely on.
   */
  const drawingRef = useRef<Mark | null>(null);
  const [drawing, setDrawing] = useState<Mark | null>(null);
  const [typing, setTyping] = useState<{ x: number; y: number; value: string } | null>(null);
  const [saving, setSaving] = useState(false);
  /** Index into `marks`, when one is picked up. Null means nothing is selected. */
  const [selected, setSelected] = useState<number | null>(null);
  /** Where the pointer last was while dragging an existing mark, in image pixels. */
  const movingRef = useRef<{ index: number; x: number; y: number } | null>(null);

  // Load once. The image element is kept rather than re-decoded per repaint:
  // repaint runs on every pointer move, and decoding a 1600px JPEG each time
  // makes drawing feel like it is fighting you.
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      setSize({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.src = src;
  }, [src]);

  /**
   * `chrome` draws the selection ring. Save passes false so editor furniture
   * cannot end up flattened into the image the user keeps.
   */
  const repaint = useCallback((chrome = true) => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    // Only on the first paint: assigning width or height resets the entire
    // canvas, and this runs on every pointermove of a drag.
    if (canvas.width !== img.naturalWidth) canvas.width = img.naturalWidth;
    if (canvas.height !== img.naturalHeight) canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(img, 0, 0);
    paintAll(ctx, drawing ? [...marks, drawing] : marks, img.naturalWidth);
    const picked = selected !== null ? marks[selected] : undefined;
    if (chrome && picked) paintSelection(ctx, picked, img.naturalWidth);
  }, [marks, drawing, selected]);

  useEffect(() => {
    if (size) repaint();
  }, [size, repaint]);

  /**
   * Screen → image pixels. Without this every mark lands offset by the scale
   * factor between the displayed canvas and the real image.
   *
   * Returns null when the canvas has no layout size — a window too short for
   * `max-h-[80vh]` to resolve to anything, or a measurement taken before layout
   * settles. Dividing by that zero silently yields NaN for every coordinate,
   * which is far worse than declining the gesture.
   */
  const toImage = (e: React.PointerEvent | React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return {
      x: ((e.clientX - r.left) / r.width) * canvas.width,
      y: ((e.clientY - r.top) / r.height) * canvas.height,
    };
  };

  const commit = (m: Mark) => {
    if (!isDegenerate(m)) setMarks((p) => [...p, m]);
  };

  // Clears the selection too: indices shift when the list shrinks, so a stale
  // one would ring — or delete — a different mark than the one that was picked.
  const undo = useCallback(() => {
    setMarks((p) => p.slice(0, -1));
    setSelected(null);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing) return; // let the label field have its own keys
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      }
      if ((e.key === "Backspace" || e.key === "Delete") && selected !== null) {
        e.preventDefault();
        setMarks((p) => p.filter((_, i) => i !== selected));
        setSelected(null);
      }
      // Escape steps back one level at a time: drop the selection first, and
      // only close the editor when there is nothing left to deselect.
      if (e.key === "Escape") {
        if (selected !== null) setSelected(null);
        else onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, onCancel, typing, selected]);

  const start = (e: React.PointerEvent) => {
    if (saving || typing) return;
    const at = toImage(e);
    if (!at) return;
    const { x, y } = at;

    /**
     * Landing on an existing mark picks it up rather than starting a new one.
     *
     * This is why there is no fifth "select" tool: 04 keeps the annotation
     * surface to four, and a mark under the cursor is unambiguous about what the
     * drag means. The cost is that you cannot draw *on top of* an existing mark
     * without moving it away first — a fair trade in a quick editor where undo
     * is one key away.
     */
    const hit = hitTest(marks, x, y, size?.w ?? 0);
    if (hit !== null) {
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      movingRef.current = { index: hit, x, y };
      setSelected(hit);
      return;
    }
    setSelected(null);

    if (tool === "text") {
      setTyping({ x, y, value: "" });
      return;
    }
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    // Held separately because a rect's own x/y move as it is dragged backwards —
    // reading the anchor back off the shape in progress loses it on the first
    // pointermove and collapses the rect to nothing.
    anchorRef.current = { x, y };
    const started: Mark =
      tool === "arrow"
        ? { kind: "arrow", color, x1: x, y1: y, x2: x, y2: y }
        : tool === "box"
          ? { kind: "box", color, x, y, w: 0, h: 0 }
          : { kind: "blur", x, y, w: 0, h: 0 };
    drawingRef.current = started;
    setDrawing(started);
  };

  const move = (e: React.PointerEvent) => {
    // Dragging an existing mark: shift by how far the pointer moved since the
    // last event, rather than snapping the mark's origin to the cursor — that
    // would teleport it by however far from its corner you grabbed it.
    const m = movingRef.current;
    if (m) {
      const at = toImage(e);
      if (!at) return;
      const dx = at.x - m.x;
      const dy = at.y - m.y;
      movingRef.current = { ...m, x: at.x, y: at.y };
      setMarks((p) => p.map((mk, i) => (i === m.index ? translate(mk, dx, dy) : mk)));
      return;
    }

    const a = anchorRef.current;
    const d = drawingRef.current;
    if (!d || !a) return;
    const at = toImage(e);
    if (!at) return;
    const { x, y } = at;
    // rectFrom keeps width and height positive, so dragging up-and-left
    // behaves exactly like dragging down-and-right.
    const next: Mark = d.kind === "arrow" ? { ...d, x2: x, y2: y } : { ...d, ...rectFrom(a.x, a.y, x, y) };
    drawingRef.current = next;
    setDrawing(next);
  };

  const end = () => {
    if (movingRef.current) {
      movingRef.current = null;
      return;
    }
    const d = drawingRef.current;
    if (!d) return;
    commit(d);
    drawingRef.current = null;
    anchorRef.current = null;
    setDrawing(null);
  };

  async function save() {
    const canvas = canvasRef.current;
    if (!canvas || saving) return;
    setSaving(true);
    // Repaint without the in-progress mark *and* without the selection ring, so
    // neither a half-drawn shape nor editor chrome can be baked into the image.
    repaint(false);
    try {
      await onSave(canvas.toDataURL("image/jpeg", 0.9), redacts(marks));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2 text-xs">
        {(["arrow", "box", "text", "blur"] as Tool[]).map((t) => (
          <button
            key={t}
            onClick={() => setTool(t)}
            className={`rounded-md px-2.5 py-1.5 capitalize ${
              tool === t ? "bg-accent text-accent-ink" : "border border-line hover:border-accent"
            }`}
          >
            {t}
          </button>
        ))}

        <span className="mx-1 h-4 w-px bg-line" />

        {/* Hidden for blur: it has no colour — it removes pixels rather than adding ink. */}
        {tool !== "blur" &&
          PALETTE.map((c) => (
            <button
              key={c}
              aria-label={`Colour ${c}`}
              onClick={() => setColor(c)}
              style={{ background: c }}
              className={`h-5 w-5 rounded-full ${color === c ? "ring-2 ring-fg ring-offset-1 ring-offset-background" : ""}`}
            />
          ))}

        <div className="ml-auto flex items-center gap-2">
          {marks.length > 0 && (
            <button onClick={undo} className="rounded-md border border-line px-2.5 py-1.5 hover:border-accent">
              Undo
            </button>
          )}
          <button onClick={onCancel} className="rounded-md border border-line px-2.5 py-1.5 hover:border-accent">
            Cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={saving || marks.length === 0}
            className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-ink disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <div className="relative flex-1 overflow-auto p-4">
        <div className="relative mx-auto w-fit">
          <canvas
            ref={canvasRef}
            onPointerDown={start}
            onPointerMove={move}
            onPointerUp={end}
            className="max-h-[80vh] w-auto max-w-full cursor-crosshair rounded-lg ring-1 ring-line"
          />

          {typing && (
            <input
              autoFocus
              value={typing.value}
              onChange={(e) => setTyping({ ...typing, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  commit({
                    kind: "text", color, x: typing.x, y: typing.y,
                    text: typing.value, size: textSizeFor(size?.w ?? 800),
                  });
                  setTyping(null);
                }
                if (e.key === "Escape") setTyping(null);
              }}
              onBlur={() => setTyping(null)}
              placeholder="Label, then ⏎"
              className="absolute rounded border border-accent bg-surface px-2 py-1 text-xs"
              style={{
                // Back from image pixels to where the canvas actually sits.
                left: `${(typing.x / (size?.w || 1)) * 100}%`,
                top: `${(typing.y / (size?.h || 1)) * 100}%`,
              }}
            />
          )}
        </div>

        <p className="mt-3 text-center text-[11px] text-muted">
          {tool === "blur"
            ? "Blur is baked into the saved image — the pixels are gone, not hidden."
            : selected !== null
              ? "Drag to move · ⌫ delete · Esc deselect"
              : "Drag to draw · drag a mark to move it · ⌘Z undo · Esc close"}
        </p>
      </div>
    </div>
  );
}
