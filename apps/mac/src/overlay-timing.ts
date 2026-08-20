export type OverlayTimerHandle = number;

export type OverlayTimerScheduler = {
  now: () => number;
  set: (callback: () => void, delayMs: number) => OverlayTimerHandle;
  clear: (handle: OverlayTimerHandle) => void;
};

export function createOverlayAutoDismissTimer(
  durationMs: number | null,
  callback: () => void,
  scheduler: OverlayTimerScheduler,
) {
  if (durationMs === null) return null;
  return new PausableOverlayTimer(durationMs, callback, scheduler);
}

/**
 * One-shot timeout whose remaining duration survives hover, dialogs, and
 * explicit actions. Resetting for a new capture invalidates the old timer.
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
