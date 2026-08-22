export type OverlayTimerHandle = number;

export type OverlayTimerScheduler = {
  now: () => number;
  set: (callback: () => void, delayMs: number) => OverlayTimerHandle;
  clear: (handle: OverlayTimerHandle) => void;
};

export type OverlayAutoDismissIdentity = {
  path: string;
  presentationId: number;
  surfaceGeneration: number;
};

export type OverlayPaintIdentity = OverlayAutoDismissIdentity & {
  presentation: number;
  surfaceGeneration: number;
  reducedMotion: boolean;
};

export type OverlaySurfaceIdentity = {
  surfaceGeneration: number;
};

export type OverlayRendererIdentity = {
  presentation: number;
  surfaceGeneration: number;
};

export type OverlayFrameScheduler = {
  request: (callback: () => void) => number;
  cancel: (handle: number) => void;
};

type NativePaintWriter = (identity: OverlayPaintIdentity) => Promise<boolean>;
type NativeSurfaceWriter = (identity: OverlaySurfaceIdentity) => Promise<boolean>;

type OverlayPaintRetryOptions = {
  maxAttempts?: number;
  wait?: () => Promise<void>;
  onFailed?: (identity: OverlayPaintIdentity) => void;
};

export type NativeOverlayRevealResult = "shown" | "not_shown" | "stale" | "failed";

type NativePauseWriter = (
  identity: OverlayAutoDismissIdentity,
  paused: boolean,
) => Promise<boolean>;

/**
 * Preserves the order of renderer-owned pause changes across asynchronous IPC.
 * Native validates the exact path/presentation, so queued work from a replaced
 * capture is harmless and cannot mutate the replacement.
 */
export class NativeOverlayAutoDismissBridge {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly write: NativePauseWriter;

  constructor(write: NativePauseWriter) {
    this.write = write;
  }

  setPaused(identity: OverlayAutoDismissIdentity, paused: boolean): Promise<boolean> {
    const operation = this.chain
      .catch(() => undefined)
      .then(() => this.write(identity, paused));
    this.chain = operation.catch(() => undefined);
    return operation.catch(() => false);
  }
}

export function rendererOwnsAutoDismissPause(
  pointerInteraction: boolean,
  swipePhase: string,
  busyAction: string | null,
  toolbarHovered = false,
) {
  return (
    toolbarHovered ||
    pointerInteraction ||
    swipePhase !== "idle" ||
    (busyAction !== null && busyAction !== "drag")
  );
}

export function shouldRequestOverlayReveal(
  imageReady: boolean,
  imageFailed: boolean,
  temporarilyHidden: boolean,
  surfaceWarm: boolean,
  isRevealed: boolean,
) {
  return imageReady && !imageFailed && !temporarilyHidden && surfaceWarm && !isRevealed;
}

export function shouldAcceptOverlaySurfaceGeneration(
  currentGeneration: number,
  incomingGeneration: number,
) {
  return incomingGeneration >= currentGeneration;
}

export function isExactOverlayRendererIdentity(
  current: OverlayRendererIdentity,
  candidate: OverlayRendererIdentity,
) {
  return (
    current.presentation === candidate.presentation &&
    current.surfaceGeneration === candidate.surfaceGeneration
  );
}

/**
 * Hides the renderer synchronously, lets that DOM state cross two WebKit paint
 * boundaries, then permits native to make the still-hidden webview warm. The
 * native surface generation prevents a late acknowledgement from reviving a
 * replacement or a later hide/restore cycle of the same capture.
 */
export function scheduleOverlayDomHiddenAcknowledgement(
  identity: OverlaySurfaceIdentity,
  isCurrent: () => boolean,
  conceal: () => void,
  acknowledge: NativeSurfaceWriter,
  onAcknowledged: (identity: OverlaySurfaceIdentity) => void,
  scheduler: OverlayFrameScheduler,
  retry: {
    maxAttempts?: number;
    wait?: () => Promise<void>;
    onFailed?: (identity: OverlaySurfaceIdentity) => void;
  } = {},
) {
  let active = true;
  let firstFrame: number | null = null;
  let paintedFrame: number | null = null;

  if (!isCurrent()) return () => undefined;
  conceal();
  firstFrame = scheduler.request(() => {
    firstFrame = null;
    if (!active || !isCurrent()) return;
    paintedFrame = scheduler.request(() => {
      paintedFrame = null;
      if (!active || !isCurrent()) return;
      void (async () => {
        const attempts = Math.max(1, Math.floor(retry.maxAttempts ?? 1));
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          if (!active || !isCurrent()) return;
          let acknowledged = false;
          try {
            acknowledged = await acknowledge(identity);
          } catch {
            acknowledged = false;
          }
          if (!active || !isCurrent()) return;
          if (acknowledged) {
            onAcknowledged(identity);
            return;
          }
          if (attempt < attempts) await (retry.wait?.() ?? Promise.resolve());
        }
        if (active && isCurrent()) retry.onFailed?.(identity);
      })();
    });
  });

  return () => {
    active = false;
    if (firstFrame !== null) scheduler.cancel(firstFrame);
    if (paintedFrame !== null) scheduler.cancel(paintedFrame);
    firstFrame = null;
    paintedFrame = null;
  };
}

export async function requestNativeOverlayRevealWithRetry(
  show: () => Promise<boolean>,
  isCurrent: () => boolean,
  wait: () => Promise<void>,
  maxAttempts: number,
): Promise<NativeOverlayRevealResult> {
  const attempts = Math.max(1, Math.floor(maxAttempts));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (!isCurrent()) return "stale";
    try {
      const shown = await show();
      if (!isCurrent()) return "stale";
      return shown ? "shown" : "not_shown";
    } catch {
      if (!isCurrent()) return "stale";
      if (attempt === attempts) return "failed";
      await wait();
    }
  }
  return "failed";
}

/**
 * Presents one decoded capture on the first frame after native show, then
 * acknowledges its first painted frame on the next frame. Every boundary is
 * guarded by the renderer generation; native independently validates the
 * exact path and presentation id.
 */
export function scheduleOverlayPaintAcknowledgement(
  identity: OverlayPaintIdentity,
  isCurrent: () => boolean,
  reveal: () => void,
  acknowledge: NativePaintWriter,
  onAcknowledged: (identity: OverlayPaintIdentity) => void,
  scheduler: OverlayFrameScheduler,
  retry: OverlayPaintRetryOptions = {},
) {
  let active = true;
  let revealFrame: number | null = null;
  let paintedFrame: number | null = null;

  revealFrame = scheduler.request(() => {
    revealFrame = null;
    if (!active || !isCurrent()) return;
    reveal();

    paintedFrame = scheduler.request(() => {
      paintedFrame = null;
      if (!active || !isCurrent()) return;
      void (async () => {
        const attempts = Math.max(1, Math.floor(retry.maxAttempts ?? 1));
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          if (!active || !isCurrent()) return;
          let acknowledged = false;
          try {
            acknowledged = await acknowledge(identity);
          } catch {
            acknowledged = false;
          }
          if (!active || !isCurrent()) return;
          if (acknowledged) {
            onAcknowledged(identity);
            return;
          }
          if (attempt < attempts) await (retry.wait?.() ?? Promise.resolve());
        }
        if (active && isCurrent()) retry.onFailed?.(identity);
      })();
    });
  });

  return () => {
    active = false;
    if (revealFrame !== null) scheduler.cancel(revealFrame);
    if (paintedFrame !== null) scheduler.cancel(paintedFrame);
    revealFrame = null;
    paintedFrame = null;
  };
}

export function createOverlayAutoDismissTimer(
  durationMs: number | null,
  callback: () => void,
  scheduler: OverlayTimerScheduler,
) {
  if (durationMs === null) return null;
  return new PausableOverlayTimer(durationMs, callback, scheduler);
}

/**
 * One-shot renderer mirror whose remaining duration survives explicit
 * interactions. Resetting for a new capture invalidates the old timer.
 */
export class PausableOverlayTimer {
  private handle: OverlayTimerHandle | null = null;
  private remaining: number;
  private startedAt: number | null = null;
  private readonly durationMs: number;
  private readonly callback: () => void;
  private readonly scheduler: OverlayTimerScheduler;

  constructor(
    durationMs: number,
    callback: () => void,
    scheduler: OverlayTimerScheduler,
  ) {
    this.durationMs = durationMs;
    this.callback = callback;
    this.scheduler = scheduler;
    this.remaining = durationMs;
  }

  start() {
    if (this.handle !== null) return;
    // An exhausted timer has already delivered its one callback. A native
    // dismiss failure must not turn the timeout into an immediate retry loop.
    if (this.remaining <= 0) return;

    this.startedAt = this.scheduler.now();
    this.handle = this.scheduler.set(() => {
      this.handle = null;
      this.startedAt = null;
      this.remaining = 0;
      this.callback();
    }, this.remaining);
  }

  pause() {
    if (this.handle === null || this.startedAt === null) return;
    this.scheduler.clear(this.handle);
    this.handle = null;
    this.remaining = Math.max(
      0,
      this.remaining - (this.scheduler.now() - this.startedAt),
    );
    this.startedAt = null;
  }

  reset() {
    this.cancel();
    this.remaining = this.durationMs;
  }

  cancel() {
    if (this.handle !== null) this.scheduler.clear(this.handle);
    this.handle = null;
    this.startedAt = null;
  }

  remainingMs() {
    if (this.startedAt === null) return this.remaining;
    return Math.max(0, this.remaining - (this.scheduler.now() - this.startedAt));
  }
}
