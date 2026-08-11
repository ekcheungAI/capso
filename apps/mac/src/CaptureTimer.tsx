import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useMemo, useState } from "react";

type RegionTimerStatus = {
  generation: number;
  running: boolean;
  secondsRemaining: number;
};

const PREVIEW_TIMER: RegionTimerStatus = {
  generation: 1,
  running: true,
  secondsRemaining: 5,
};

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

export default function CaptureTimer() {
  const nativeRuntime = useMemo(isTauriRuntime, []);
  const [timer, setTimer] = useState<RegionTimerStatus | null>(() =>
    nativeRuntime ? null : PREVIEW_TIMER,
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!nativeRuntime) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;

    void (async () => {
      unlisten = await listen<RegionTimerStatus>("region-timer-changed", ({ payload }) => {
        if (!disposed) setTimer(payload);
      });
      const current = await invoke<RegionTimerStatus>("get_region_self_timer_status");
      if (!disposed) setTimer(current);
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [nativeRuntime]);

  async function cancelTimer() {
    if (!nativeRuntime || !timer?.running || busy) return;
    setBusy(true);
    try {
      await invoke("cancel_region_self_timer");
    } finally {
      setBusy(false);
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
    <main className="capture-timer" aria-label="Area capture timer">
      <div className="capture-timer__count" aria-hidden="true">
        {timer.secondsRemaining}
      </div>
      <div className="capture-timer__copy">
        <strong>Area capture</strong>
        <span>Starting in {timer.secondsRemaining} seconds</span>
      </div>
      <button
        type="button"
        aria-label="Cancel area capture timer"
        disabled={busy}
        onClick={() => void cancelTimer()}
      >
        Cancel
      </button>
      <p className="capture-timer__announcement" aria-live="polite">
        Area capture timer active. Cancel is available.
      </p>
    </main>
  );
}
