import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState } from "react";

type FreezeFrame = {
  generation: number;
  path: string;
};

const PREVIEW_FRAME: FreezeFrame = { generation: 1, path: "" };

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

export default function FreezeScreen() {
  const nativeRuntime = useMemo(isTauriRuntime, []);
  const [frame, setFrame] = useState<FreezeFrame | null>(() =>
    nativeRuntime ? null : PREVIEW_FRAME,
  );
  const generationRef = useRef<number | null>(frame?.generation ?? null);
  const cancelGenerationInFlight = useRef<number | null>(null);

  useEffect(() => {
    if (!nativeRuntime) return;
    let disposed = false;
    let receivedFrameEvent = false;
    let unlisten: UnlistenFn | undefined;
    void (async () => {
      const stopListening = await listen<FreezeFrame>("freeze-frame-changed", ({ payload }) => {
        if (disposed) return;
        receivedFrameEvent = true;
        if (
          cancelGenerationInFlight.current !== null
          && cancelGenerationInFlight.current !== payload.generation
        ) cancelGenerationInFlight.current = null;
        generationRef.current = payload.generation;
        setFrame(payload);
      });
      if (disposed) {
        stopListening();
        return;
      }
      unlisten = stopListening;
      const current = await invoke<FreezeFrame | null>("get_freeze_frame");
      if (!disposed && current && !receivedFrameEvent) {
        generationRef.current = current.generation;
        setFrame(current);
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [nativeRuntime]);

  async function cancel(requestedGeneration?: number) {
    const generation = requestedGeneration ?? generationRef.current;
    if (!nativeRuntime || generation === null || cancelGenerationInFlight.current !== null) return;
    cancelGenerationInFlight.current = generation;
    try {
      await invoke("cancel_freeze_capture", { generation });
    } finally {
      if (cancelGenerationInFlight.current === generation) {
        cancelGenerationInFlight.current = null;
      }
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void cancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [nativeRuntime, frame?.generation]);

  const source = nativeRuntime && frame?.path
    ? `${convertFileSrc(frame.path)}?freeze=${frame.generation}`
    : null;

  return (
    <main className="freeze-screen" aria-label="Frozen main display. Press Escape to cancel.">
      {source && frame ? (
        <img
          src={source}
          alt=""
          draggable={false}
          onLoad={() => {
            if (!nativeRuntime || generationRef.current !== frame.generation) return;
            void invoke("freeze_frame_ready", { generation: frame.generation });
          }}
          onError={() => void cancel(frame.generation)}
        />
      ) : (
        <div className="freeze-screen__preview" aria-hidden="true" />
      )}
    </main>
  );
}
