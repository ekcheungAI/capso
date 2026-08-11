import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState } from "react";

type PinCapturePayload = {
  path: string;
  presentationId: number;
};

type ClipboardStatus =
  | { status: "copied"; bytes: number }
  | { status: "unchanged" }
  | { status: "failed"; code: string; message: string };

type PinCopyEvent = {
  presentationId: number;
  result: ClipboardStatus;
};

const PREVIEW_PIN: PinCapturePayload = { path: "", presentationId: 0 };

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

function CloseIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m6 6 8 8M14 6l-8 8" />
    </svg>
  );
}

export default function PinCapture() {
  const nativeRuntime = useMemo(isTauriRuntime, []);
  const [capture, setCapture] = useState<PinCapturePayload | null>(() =>
    nativeRuntime ? null : PREVIEW_PIN,
  );
  const [notice, setNotice] = useState("Pinned above your work");
  const [busy, setBusy] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const activePresentationRef = useRef<number | null>(capture?.presentationId ?? null);

  useEffect(() => {
    if (!nativeRuntime) return;
    let disposed = false;
    let unlistenPin: UnlistenFn | undefined;
    let unlistenCopy: UnlistenFn | undefined;

    void (async () => {
      unlistenPin = await listen<PinCapturePayload>("pin-capture", ({ payload }) => {
        if (disposed) return;
        activePresentationRef.current = payload.presentationId;
        setImageFailed(false);
        setNotice("Pinned above your work");
        setCapture(payload);
      });
      unlistenCopy = await listen<PinCopyEvent>("pin-copy-finished", ({ payload }) => {
        if (disposed || activePresentationRef.current !== payload.presentationId) return;
        setBusy(false);
        setNotice(
          payload.result.status === "copied"
            ? "Copied to clipboard"
            : payload.result.status === "failed"
              ? payload.result.message
              : "Clipboard unchanged",
        );
      });
      const current = await invoke<PinCapturePayload | null>("get_pin_capture");
      if (!disposed && current) {
        activePresentationRef.current = current.presentationId;
        setCapture(current);
      }
    })();

    return () => {
      disposed = true;
      unlistenPin?.();
      unlistenCopy?.();
    };
  }, [nativeRuntime]);

  async function copyCapture() {
    if (!nativeRuntime || !capture) return;
    setBusy(true);
    setNotice("Copying…");
    try {
      await invoke("copy_pin_capture", {
        presentationId: capture.presentationId,
      });
    } catch (error) {
      setNotice(`Copy failed: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function closeCapture() {
    if (!nativeRuntime || !capture) return;
    setBusy(true);
    try {
      await invoke("close_pin_capture", { presentationId: capture.presentationId });
      activePresentationRef.current = null;
      setCapture(null);
    } catch (error) {
      setNotice(`Close failed: ${String(error)}`);
      setBusy(false);
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

  return (
    <main className="pin-capture" aria-label="Pinned Capso capture">
      <div className="pin-capture__drag" data-tauri-drag-region>
        <span data-tauri-drag-region>{notice}</span>
      </div>
      {source && !imageFailed ? (
        <img
          src={source}
          alt="Pinned screenshot"
          draggable={false}
          onLoad={() => {
            if (nativeRuntime) {
              void invoke("pin_image_ready", {
                presentationId: capture.presentationId,
              });
            }
          }}
          onError={() => {
            setImageFailed(true);
            if (nativeRuntime) {
              void invoke("pin_image_ready", {
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
      <div className="pin-capture__actions" role="toolbar" aria-label="Pinned capture actions">
        <button type="button" aria-label="Copy pinned capture" disabled={busy} onClick={() => void copyCapture()}>
          <CopyIcon />
        </button>
        <button type="button" aria-label="Close pinned capture" disabled={busy} onClick={() => void closeCapture()}>
          <CloseIcon />
        </button>
      </div>
    </main>
  );
}
