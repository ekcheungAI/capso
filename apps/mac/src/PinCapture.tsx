import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

type PinCapturePayload = {
  pinId: string;
  path: string;
  presentationId: number;
  width: number;
  height: number;
  x: number | null;
  y: number | null;
  opacity: number;
  locked: boolean;
};

type ClipboardStatus =
  | { status: "copied"; bytes: number }
  | { status: "unchanged" }
  | { status: "failed"; code: string; message: string };

type PinCopyEvent = {
  pinId: string;
  presentationId: number;
  result: ClipboardStatus;
};

const parameters = new URLSearchParams(window.location.search);
const requestedPinId = parameters.get("pinId");
const PREVIEW_PIN: PinCapturePayload = {
  pinId: "00000000-0000-0000-0000-000000000001",
  path: "",
  presentationId: 1,
  width: 420,
  height: 300,
  x: null,
  y: null,
  opacity: parameters.get("preview") === "locked" ? 40 : 80,
  locked: parameters.get("preview") === "locked",
};

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="6.5" y="6.5" width="9" height="9" rx="2" />
      <path d="M13 6.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h.5" />
    </svg>
  );
}

function MinusIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M5 10h10" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M5 10h10M10 5v10" />
    </svg>
  );
}

function LockIcon({ locked }: { locked: boolean }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="5" y="8.5" width="10" height="7.5" rx="2" />
      <path d={locked ? "M7.25 8.5V6.75a2.75 2.75 0 0 1 5.5 0V8.5" : "M12.75 8.5V6.75a2.75 2.75 0 0 0-5.3-1"} />
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

export default function PinCapture() {
  const nativeRuntime = useMemo(isTauriRuntime, []);
  const pinId = nativeRuntime ? requestedPinId : PREVIEW_PIN.pinId;
  const [capture, setCapture] = useState<PinCapturePayload | null>(() =>
    nativeRuntime ? null : PREVIEW_PIN,
  );
  const [notice, setNotice] = useState(
    !nativeRuntime && PREVIEW_PIN.locked ? "Locked in place" : "Pinned above your work",
  );
  const [busy, setBusy] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const activePresentationRef = useRef<number | null>(capture?.presentationId ?? null);
  const pinActionInFlight = useRef<string | null>(null);

  function beginPinAction(key: string) {
    if (pinActionInFlight.current !== null) return false;
    pinActionInFlight.current = key;
    setBusy(true);
    return true;
  }

  function endPinAction(key: string) {
    if (pinActionInFlight.current !== key) return;
    pinActionInFlight.current = null;
    setBusy(false);
  }

  useEffect(() => {
    if (!nativeRuntime || !pinId) return;
    let disposed = false;
    let receivedPinEvent = false;
    let unlistenPin: UnlistenFn | undefined;
    let unlistenCopy: UnlistenFn | undefined;

    void (async () => {
      unlistenPin = await listen<PinCapturePayload>("pin-capture", ({ payload }) => {
        if (disposed || payload.pinId !== pinId) return;
        receivedPinEvent = true;
        activePresentationRef.current = payload.presentationId;
        pinActionInFlight.current = null;
        setBusy(false);
        setImageFailed(false);
        setNotice(payload.locked ? "Locked in place" : "Pinned above your work");
        setCapture(payload);
      });
      unlistenCopy = await listen<PinCopyEvent>("pin-copy-finished", ({ payload }) => {
        if (
          disposed
          || payload.pinId !== pinId
          || activePresentationRef.current !== payload.presentationId
        ) return;
        endPinAction(`copy:${payload.presentationId}`);
        setNotice(
          payload.result.status === "copied"
            ? "Copied to clipboard"
            : payload.result.status === "failed"
              ? payload.result.message
              : "Clipboard unchanged",
        );
      });
      const current = await invoke<PinCapturePayload | null>("get_pin_capture", { pinId });
      if (!disposed && current && !receivedPinEvent) {
        activePresentationRef.current = current.presentationId;
        setCapture(current);
        setNotice(current.locked ? "Locked in place" : "Pinned above your work");
      }
    })().catch((error) => {
      if (!disposed) setNotice(`Pin unavailable: ${String(error)}`);
    });

    return () => {
      disposed = true;
      unlistenPin?.();
      unlistenCopy?.();
    };
  }, [nativeRuntime, pinId]);

  async function copyCapture() {
    if (!nativeRuntime || !capture) return;
    const actionKey = `copy:${capture.presentationId}`;
    if (!beginPinAction(actionKey)) return;
    setNotice("Copying…");
    try {
      await invoke("copy_pin_capture", {
        pinId: capture.pinId,
        presentationId: capture.presentationId,
      });
    } catch (error) {
      setNotice(`Copy failed: ${String(error)}`);
      endPinAction(actionKey);
    }
  }

  async function updateCapture(
    command: "resize_pin_capture" | "set_pin_opacity" | "set_pin_locked",
    values: Record<string, unknown>,
    successNotice: string,
  ) {
    if (!nativeRuntime || !capture) return;
    const actionKey = `update:${capture.presentationId}`;
    if (!beginPinAction(actionKey)) return;
    try {
      const updated = await invoke<PinCapturePayload>(command, {
        pinId: capture.pinId,
        presentationId: capture.presentationId,
        ...values,
      });
      if (activePresentationRef.current === updated.presentationId) {
        setCapture(updated);
        setNotice(successNotice);
      }
    } catch (error) {
      setNotice(`Pin update failed: ${String(error)}`);
    } finally {
      endPinAction(actionKey);
    }
  }

  async function closeCapture() {
    if (!nativeRuntime || !capture) return;
    const actionKey = `close:${capture.presentationId}`;
    if (!beginPinAction(actionKey)) return;
    try {
      await invoke("close_pin_capture", {
        pinId: capture.pinId,
        presentationId: capture.presentationId,
      });
      activePresentationRef.current = null;
      setCapture(null);
    } catch (error) {
      setNotice(`Close failed: ${String(error)}`);
    } finally {
      endPinAction(actionKey);
    }
  }

  useEffect(() => {
    if (!capture) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void closeCapture();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [capture?.presentationId, busy]);

  if (!capture) return <main className="pin-capture pin-capture--waiting" aria-hidden="true" />;
  const source = nativeRuntime && capture.path
    ? `${convertFileSrc(capture.path)}?pin=${capture.presentationId}`
    : null;
  const contentStyle = { "--pin-opacity": capture.opacity / 100 } as CSSProperties;

  return (
    <main
      className={`pin-capture${capture.locked ? " pin-capture--locked" : ""}`}
      aria-label="Pinned Capso capture"
    >
      <div
        className="pin-capture__drag"
        data-tauri-drag-region={capture.locked ? undefined : true}
      >
        <span data-tauri-drag-region={capture.locked ? undefined : true}>{notice}</span>
      </div>
      <div className="pin-capture__content" style={contentStyle}>
        {source && !imageFailed ? (
          <img
            src={source}
            alt="Pinned screenshot"
            draggable={false}
            onLoad={() => {
              if (nativeRuntime) {
                void invoke("pin_image_ready", {
                  pinId: capture.pinId,
                  presentationId: capture.presentationId,
                });
              }
            }}
            onError={() => {
              setImageFailed(true);
              if (nativeRuntime) {
                void invoke("pin_image_ready", {
                  pinId: capture.pinId,
                  presentationId: capture.presentationId,
                });
              }
            }}
          />
        ) : imageFailed ? (
          <div className="pin-capture__fallback">The local original could not be previewed.</div>
        ) : (
          <div className="pin-capture__preview" aria-hidden="true" />
        )}
      </div>
      <div className="pin-capture__actions" role="toolbar" aria-label="Pinned capture actions">
        <label className="pin-capture__opacity">
          <span>Opacity</span>
          <input
            type="range"
            min="40"
            max="100"
            step="10"
            value={capture.opacity}
            aria-label="Pinned capture opacity"
            aria-valuetext={`${capture.opacity}%`}
            disabled={busy}
            onChange={(event) => void updateCapture(
              "set_pin_opacity",
              { opacity: Number(event.currentTarget.value) },
              `${event.currentTarget.value}% opacity`,
            )}
          />
        </label>
        <div className="pin-capture__action-row">
          <button type="button" aria-label="Copy pinned capture" disabled={busy} onClick={() => void copyCapture()}>
            <CopyIcon />
          </button>
          <button
            type="button"
            aria-label="Decrease pinned capture size"
            disabled={busy || (capture.width <= 180 && capture.height <= 120)}
            onClick={() => void updateCapture("resize_pin_capture", { direction: -1 }, "Pin made smaller")}
          >
            <MinusIcon />
          </button>
          <button
            type="button"
            aria-label="Increase pinned capture size"
            disabled={busy || (capture.width >= 960 || capture.height >= 720)}
            onClick={() => void updateCapture("resize_pin_capture", { direction: 1 }, "Pin made larger")}
          >
            <PlusIcon />
          </button>
          <button
            type="button"
            aria-label={capture.locked ? "Unlock pinned capture" : "Lock pinned capture"}
            aria-pressed={capture.locked}
            disabled={busy}
            onClick={() => void updateCapture(
              "set_pin_locked",
              { locked: !capture.locked },
              capture.locked ? "Pin unlocked" : "Pin locked in place",
            )}
          >
            <LockIcon locked={capture.locked} />
          </button>
          <button type="button" aria-label="Close pinned capture" disabled={busy} onClick={() => void closeCapture()}>
            <CloseIcon />
          </button>
        </div>
      </div>
    </main>
  );
}
