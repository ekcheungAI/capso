export type OverlayTimerHandle = number;

export type OverlayTimerScheduler = {
  now: () => number;
  set: (callback: () => void, delayMs: number) => OverlayTimerHandle;
  clear: (handle: OverlayTimerHandle) => void;
};

export type OverlayAutoDismissIdentity = {
  path: string;
  presentationId: number;
};

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
) {
  return (
    pointerInteraction ||
    swipePhase !== "idle" ||
    (busyAction !== null && busyAction !== "drag")
  );
}

export function shouldRequestOverlayReveal(
  imageReady: boolean,
  imageFailed: boolean,
  temporarilyHidden: boolean,
  isRevealed: boolean,
) {
  return imageReady && !imageFailed && !temporarilyHidden && !isRevealed;
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
