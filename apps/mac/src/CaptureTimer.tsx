import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState } from "react";

type CaptureTimerStatus = {
  generation: number;
  running: boolean;
  secondsRemaining: number;
  mode: "region" | "window" | "fullscreen";
  freezeScreen: boolean;
};

const PREVIEW_TIMER: CaptureTimerStatus = {
  generation: 1,
  running: true,
  secondsRemaining: 5,
  mode: "region",
  freezeScreen: false,
};

const MODE_LABEL: Record<CaptureTimerStatus["mode"], string> = {
  region: "Area",
  window: "Window",
  fullscreen: "Full screen",
};

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

export default function CaptureTimer() {
  const nativeRuntime = useMemo(isTauriRuntime, []);
  const [timer, setTimer] = useState<CaptureTimerStatus | null>(() =>
    nativeRuntime ? null : PREVIEW_TIMER,
  );
  const [busy, setBusy] = useState(false);
  const cancelGenerationInFlight = useRef<number | null>(null);

  useEffect(() => {
    if (!nativeRuntime) return;
    let disposed = false;
    let receivedTimerEvent = false;
    let unlisten: UnlistenFn | undefined;

    void (async () => {
      unlisten = await listen<CaptureTimerStatus>("capture-timer-changed", ({ payload }) => {
        if (disposed) return;
        receivedTimerEvent = true;
        if (
          cancelGenerationInFlight.current !== null
          && (payload.generation !== cancelGenerationInFlight.current || !payload.running)
        ) {
          cancelGenerationInFlight.current = null;
          setBusy(false);
        }
        setTimer(payload);
      });
      const current = await invoke<CaptureTimerStatus>("get_capture_timer_status");
      if (!disposed && !receivedTimerEvent) setTimer(current);
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [nativeRuntime]);

  async function cancelTimer() {
    if (!nativeRuntime || !timer?.running || cancelGenerationInFlight.current !== null) return;
    const generation = timer.generation;
    cancelGenerationInFlight.current = timer.generation;
    setBusy(true);
    try {
      await invoke("cancel_capture_timer");
    } finally {
      if (cancelGenerationInFlight.current === generation) {
        cancelGenerationInFlight.current = null;
        setBusy(false);
      }
    }
  }

  useEffect(() => {
    if (!timer?.running) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void cancelTimer();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [timer?.generation, timer?.running, busy]);

  if (!timer?.running) {
    return <main className="capture-timer capture-timer--waiting" aria-hidden="true" />;
  }

  return (
    <main className="capture-timer" aria-label={`${MODE_LABEL[timer.mode]} capture timer`}>
      <div className="capture-timer__count" aria-hidden="true">
        {timer.secondsRemaining}
      </div>
      <div className="capture-timer__copy">
        <strong>{timer.freezeScreen ? "Frozen Area capture" : `${MODE_LABEL[timer.mode]} capture`}</strong>
        <span>
          {timer.freezeScreen
            ? `Main display freezes in ${timer.secondsRemaining} seconds`
            : `Starting in ${timer.secondsRemaining} seconds`}
        </span>
      </div>
      <button
        type="button"
        aria-label={`Cancel ${MODE_LABEL[timer.mode].toLowerCase()} capture timer`}
        disabled={busy}
        onClick={() => void cancelTimer()}
      >
        Cancel
      </button>
      <p className="capture-timer__announcement" aria-live="polite">
        {timer.freezeScreen ? "Frozen Area" : MODE_LABEL[timer.mode]} capture timer active. Cancel is available.
      </p>
    </main>
  );
}
