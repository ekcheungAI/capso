import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  DEFAULT_COLOR,
  hitTest,
  isDegenerate,
  PALETTE,
  paintAll,
  paintSelection,
  rectFrom,
  redacts,
  textSizeFor,
  translate,
  type Mark,
  type Tool,
} from "@capso/shared/annotate";

type AnnotationCapture = {
  id: string;
  path: string;
  presentationId: number;
  sessionId: number;
};

type AnnotationSaveResult = {
  bytes: number;
  originalPath: string;
  toolsUsed: Tool[];
  redacted: boolean;
};

const PREVIEW_CAPTURE: AnnotationCapture = {
  id: "preview-capture",
  path: "",
  presentationId: 0,
  sessionId: 0,
};

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

function ToolIcon({ tool }: { tool: Tool }) {
  if (tool === "arrow") {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 16 16 4m-6 0h6v6" /></svg>;
  }
  if (tool === "box") {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4" y="4" width="12" height="12" rx="1.5" /></svg>;
  }
  if (tool === "text") {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5h12M10 5v11M7 16h6" /></svg>;
  }
  return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3.5" y="3.5" width="5" height="5" rx="1" /><rect x="11.5" y="3.5" width="5" height="5" rx="1" /><rect x="3.5" y="11.5" width="5" height="5" rx="1" /><rect x="11.5" y="11.5" width="5" height="5" rx="1" /></svg>;
}

function UndoIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 6 3.5 9.5 7 13" /><path d="M4 9.5h7.5a4.5 4.5 0 0 1 0 9H10" /></svg>;
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
  const imageRef = useRef<HTMLImageElement | null>(null);
  const anchorRef = useRef<{ x: number; y: number } | null>(null);
  const drawingRef = useRef<Mark | null>(null);
  const movingRef = useRef<{ index: number; x: number; y: number } | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [tool, setTool] = useState<Tool>("arrow");
  const [color, setColor] = useState<string>(DEFAULT_COLOR);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [drawing, setDrawing] = useState<Mark | null>(null);
  const [typing, setTyping] = useState<{ x: number; y: number; value: string } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("Draw on the image. Your original stays protected locally.");
  const [noticeIsError, setNoticeIsError] = useState(false);

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

  const repaint = useCallback((includeChrome = true) => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image) return;
    if (canvas.width !== image.naturalWidth) canvas.width = image.naturalWidth;
    if (canvas.height !== image.naturalHeight) canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(image, 0, 0);
    paintAll(context, drawing ? [...marks, drawing] : marks, image.naturalWidth);
    const picked = selected === null ? undefined : marks[selected];
    if (includeChrome && picked) paintSelection(context, picked, image.naturalWidth);
  }, [drawing, marks, selected]);

  useEffect(() => {
    if (size) repaint();
  }, [repaint, size]);

  const toImage = (event: React.PointerEvent | React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return null;
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * canvas.width,
      y: ((event.clientY - bounds.top) / bounds.height) * canvas.height,
    };
  };

  const commit = (mark: Mark) => {
    if (!isDegenerate(mark)) setMarks((current) => [...current, mark]);
  };

  const undo = useCallback(() => {
    setMarks((current) => current.slice(0, -1));
    setSelected(null);
  }, []);

  const cancel = useCallback(async () => {
    if (saving) return;
    if (!nativeRuntime) {
      setMarks([]);
      setSelected(null);
      setNotice("Preview reset. In the Mac app, Cancel returns to Quick Access.");
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
    }
  }, [capture, nativeRuntime, saving]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (typing) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undo();
      } else if ((event.key === "Backspace" || event.key === "Delete") && selected !== null) {
        event.preventDefault();
        setMarks((current) => current.filter((_, index) => index !== selected));
        setSelected(null);
      } else if (event.key === "Escape") {
        if (selected !== null) setSelected(null);
        else void cancel();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [cancel, selected, typing, undo]);

  function start(event: React.PointerEvent<HTMLCanvasElement>) {
    if (saving || typing || event.button !== 0) return;
    const at = toImage(event);
    if (!at) return;
    const hit = hitTest(marks, at.x, at.y, size?.w ?? 0);
    if (hit !== null) {
      event.currentTarget.setPointerCapture(event.pointerId);
      movingRef.current = { index: hit, ...at };
      setSelected(hit);
      return;
    }
    setSelected(null);
    if (tool === "text") {
      setTyping({ ...at, value: "" });
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    anchorRef.current = at;
    const started: Mark = tool === "arrow"
      ? { kind: "arrow", color, x1: at.x, y1: at.y, x2: at.x, y2: at.y }
      : tool === "box"
        ? { kind: "box", color, x: at.x, y: at.y, w: 0, h: 0 }
        : { kind: "blur", x: at.x, y: at.y, w: 0, h: 0 };
    drawingRef.current = started;
    setDrawing(started);
  }

  function move(event: React.PointerEvent<HTMLCanvasElement>) {
    const moving = movingRef.current;
    if (moving) {
      const at = toImage(event);
      if (!at) return;
      const dx = at.x - moving.x;
      const dy = at.y - moving.y;
      movingRef.current = { ...moving, ...at };
      setMarks((current) => current.map((mark, index) =>
        index === moving.index ? translate(mark, dx, dy) : mark));
      return;
    }
    const anchor = anchorRef.current;
    const active = drawingRef.current;
    const at = toImage(event);
    if (!anchor || !active || !at) return;
    const next: Mark = active.kind === "arrow"
      ? { ...active, x2: at.x, y2: at.y }
      : { ...active, ...rectFrom(anchor.x, anchor.y, at.x, at.y) };
    drawingRef.current = next;
    setDrawing(next);
  }

  function end() {
    if (movingRef.current) {
      movingRef.current = null;
      return;
    }
    const active = drawingRef.current;
    if (!active) return;
    commit(active);
    drawingRef.current = null;
    anchorRef.current = null;
    setDrawing(null);
  }

  function commitText() {
    if (!typing) return;
    commit({
      kind: "text",
      color,
      x: typing.x,
      y: typing.y,
      text: typing.value,
      size: textSizeFor(size?.w ?? 800),
    });
    setTyping(null);
  }

  async function save() {
    const canvas = canvasRef.current;
    if (!canvas || saving || marks.length === 0) return;
    setSaving(true);
    setNoticeIsError(false);
    setNotice("Flattening annotation into the saved capture…");
    repaint(false);
    const toolsUsed = Array.from(new Set(marks.map((mark) => mark.kind)));
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
          },
        });
      } else {
        const bytes = Math.floor((pngDataUrl.length - pngDataUrl.indexOf(",") - 1) * 0.75);
        setNotice(`Preview flattened successfully (${bytes.toLocaleString()} bytes). The installed app also re-copies this PNG.`);
      }
    } catch (error) {
      setNotice(String(error));
      setNoticeIsError(true);
    } finally {
      setSaving(false);
      repaint(true);
    }
  }

  const guidance = tool === "blur"
    ? "Pixelate destroys detail before upload - it is baked into the PNG."
    : selected !== null
      ? "Drag to move · Delete removes · Escape deselects"
      : "Drag to draw · Drag a mark to move · ⌘Z to undo";

  return (
    <main className="annotation-shell">
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
          {(["arrow", "box", "text", "blur"] as Tool[]).map((candidate) => (
            <button
              type="button"
              key={candidate}
              className="annotation-tool"
              aria-label={`${candidate} tool`}
              aria-pressed={tool === candidate}
              title={candidate === "blur" ? "Pixelate" : candidate[0]!.toUpperCase() + candidate.slice(1)}
              onClick={() => {
                setTool(candidate);
                setSelected(null);
              }}
            >
              <ToolIcon tool={candidate} />
              <span>{candidate === "blur" ? "Pixelate" : candidate}</span>
            </button>
          ))}
        </div>
        <div className="annotation-colors" aria-label="Annotation colors" data-hidden={tool === "blur"}>
          {PALETTE.map((candidate) => (
            <button
              type="button"
              key={candidate}
              aria-label={`Use color ${candidate}`}
              aria-pressed={color === candidate}
              style={{ backgroundColor: candidate }}
              onClick={() => setColor(candidate)}
            />
          ))}
        </div>
        <span className="annotation-spacer" />
        <button
          type="button"
          className="annotation-icon-button"
          aria-label="Undo last annotation"
          title="Undo ⌘Z"
          disabled={marks.length === 0 || saving}
          onClick={undo}
        ><UndoIcon /></button>
        <button type="button" className="annotation-cancel" disabled={saving} onClick={() => void cancel()}>
          Cancel
        </button>
        <button type="button" className="annotation-save" disabled={saving || marks.length === 0} onClick={() => void save()}>
          {saving ? "Saving…" : "Save & copy"}
        </button>
      </header>

      <section className="annotation-workspace" aria-label="Capture canvas">
        <div className="annotation-canvas-frame">
          <canvas
            ref={canvasRef}
            aria-label="Screenshot being annotated"
            onPointerDown={start}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
          />
          {typing && (
            <input
              autoFocus
              value={typing.value}
              placeholder="Type label, then Return"
              aria-label="Annotation label"
              style={{
                left: `${(typing.x / (size?.w || 1)) * 100}%`,
                top: `${(typing.y / (size?.h || 1)) * 100}%`,
              }}
              onChange={(event) => setTyping({ ...typing, value: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitText();
                if (event.key === "Escape") setTyping(null);
              }}
            />
          )}
        </div>
      </section>

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
    let unlisten: UnlistenFn | undefined;
    void (async () => {
      unlisten = await listen<AnnotationCapture>("annotation-capture", (event) => {
        if (!disposed) setCapture(event.payload);
      });
      const current = await invoke<AnnotationCapture | null>("get_annotation_capture");
      if (!disposed && current) setCapture(current);
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
    ? `${convertFileSrc(capture.path)}?session=${capture.sessionId}`
    : PREVIEW_IMAGE;
  return <Editor key={capture.sessionId} capture={capture} source={source} nativeRuntime={nativeRuntime} />;
}
