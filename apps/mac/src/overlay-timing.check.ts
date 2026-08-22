import assert from "node:assert/strict";
import test from "node:test";
import {
  createOverlayAutoDismissTimer,
  isExactOverlayRendererIdentity,
  NativeOverlayAutoDismissBridge,
  PausableOverlayTimer,
  rendererOwnsAutoDismissPause,
  requestNativeOverlayRevealWithRetry,
  scheduleOverlayDomHiddenAcknowledgement,
  scheduleOverlayPaintAcknowledgement,
  shouldAcceptOverlaySurfaceGeneration,
  shouldRequestOverlayReveal,
  type OverlayAutoDismissIdentity,
  type OverlayFrameScheduler,
  type OverlayTimerHandle,
  type OverlayTimerScheduler,
} from "./overlay-timing.ts";

class FakeScheduler implements OverlayTimerScheduler {
  time = 0;
  nextId = 1;
  timers = new Map<number, { at: number; callback: () => void }>();

  now = () => this.time;

  set = (callback: () => void, delayMs: number) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return id;
  };

  clear = (handle: OverlayTimerHandle) => {
    this.timers.delete(handle);
  };

  advance(ms: number) {
    this.time += ms;
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.at <= this.time)
      .sort((left, right) => left[1].at - right[1].at);
    for (const [id, timer] of due) {
      if (!this.timers.delete(id)) continue;
      timer.callback();
    }
  }
}

class FakeFrameScheduler implements OverlayFrameScheduler {
  nextId = 1;
  frames = new Map<number, () => void>();

  request = (callback: () => void) => {
    const id = this.nextId++;
    this.frames.set(id, callback);
    return id;
  };

  cancel = (handle: number) => {
    this.frames.delete(handle);
  };

  flushFrame() {
    const callbacks = [...this.frames.values()];
    this.frames.clear();
    for (const callback of callbacks) callback();
  }
}

test("Never creates no auto-dismiss timer while a timed preference keeps its exact duration", () => {
  const scheduler = new FakeScheduler();
  let dismissals = 0;

  assert.equal(
    createOverlayAutoDismissTimer(null, () => dismissals++, scheduler),
    null,
  );
  assert.equal(scheduler.timers.size, 0);

  const timer = createOverlayAutoDismissTimer(
    10_000,
    () => dismissals++,
    scheduler,
  );
  assert.ok(timer);
  timer.start();
  scheduler.advance(9_999);
  assert.equal(dismissals, 0);
  scheduler.advance(1);
  assert.equal(dismissals, 1);
});

test("interaction pause preserves the exact remaining auto-dismiss duration", () => {
  const scheduler = new FakeScheduler();
  let dismissals = 0;
  const timer = new PausableOverlayTimer(10_000, () => dismissals++, scheduler);

  timer.start();
  scheduler.advance(3_000);
  timer.pause();
  assert.equal(timer.remainingMs(), 7_000);

  scheduler.advance(20_000);
  assert.equal(dismissals, 0);

  timer.start();
  scheduler.advance(6_999);
  assert.equal(dismissals, 0);
  scheduler.advance(1);
  assert.equal(dismissals, 1);
});

test("a new capture resets and invalidates the older capture timer", () => {
  const scheduler = new FakeScheduler();
  let dismissals = 0;
  const timer = new PausableOverlayTimer(10_000, () => dismissals++, scheduler);

  timer.start();
  scheduler.advance(9_000);
  timer.reset();
  timer.start();
  scheduler.advance(1_001);
  assert.equal(dismissals, 0);
  scheduler.advance(8_999);
  assert.equal(dismissals, 1);
});

test("an expired timeout remains one-shot until a new capture resets it", () => {
  const scheduler = new FakeScheduler();
  let dismissals = 0;
  const timer = new PausableOverlayTimer(10_000, () => dismissals++, scheduler);

  timer.start();
  scheduler.advance(10_000);
  assert.equal(dismissals, 1);

  timer.start();
  timer.start();
  assert.equal(dismissals, 1);

  timer.reset();
  timer.start();
  scheduler.advance(10_000);
  assert.equal(dismissals, 2);
});

test("native interaction pauses are serialized ahead of action work", async () => {
  const identity: OverlayAutoDismissIdentity = {
    path: "/tmp/capso/current.png",
    presentationId: 7,
    surfaceGeneration: 11,
  };
  const calls: string[] = [];
  let releasePause: (() => void) | undefined;
  let markPauseStarted: (() => void) | undefined;
  const pauseStarted = new Promise<void>((resolve) => {
    markPauseStarted = resolve;
  });
  const bridge = new NativeOverlayAutoDismissBridge(async (target, paused) => {
    calls.push(
      `${target.presentationId}:${target.surfaceGeneration}:${paused ? "pause" : "resume"}`,
    );
    if (paused) {
      markPauseStarted?.();
      await new Promise<void>((resolve) => {
        releasePause = resolve;
      });
    }
    return true;
  });

  const pause = bridge.setPaused(identity, true);
  const resume = bridge.setPaused(identity, false);
  await pauseStarted;
  assert.deepEqual(calls, ["7:11:pause"]);

  releasePause?.();
  assert.equal(await pause, true);
  assert.equal(await resume, true);
  assert.deepEqual(calls, ["7:11:pause", "7:11:resume"]);
});

test("native pause failures do not poison later exact-presentation updates", async () => {
  const first: OverlayAutoDismissIdentity = {
    path: "/tmp/capso/repeated.png",
    presentationId: 1,
    surfaceGeneration: 21,
  };
  const replacement: OverlayAutoDismissIdentity = {
    path: "/tmp/capso/repeated.png",
    presentationId: 2,
    surfaceGeneration: 22,
  };
  const calls: string[] = [];
  const bridge = new NativeOverlayAutoDismissBridge(async (target, paused) => {
    calls.push(
      `${target.presentationId}:${target.surfaceGeneration}:${paused ? "pause" : "resume"}`,
    );
    if (target.presentationId === 1) throw new Error("renderer disappeared");
    return true;
  });

  assert.equal(await bridge.setPaused(first, true), false);
  assert.equal(await bridge.setPaused(replacement, false), true);
  assert.deepEqual(calls, ["1:21:pause", "2:22:resume"]);
});

test("renderer owns pointer, action, and swipe pauses but not native drag", () => {
  assert.equal(rendererOwnsAutoDismissPause(false, "idle", null), false);
  assert.equal(rendererOwnsAutoDismissPause(false, "idle", null, true), true);
  assert.equal(rendererOwnsAutoDismissPause(true, "idle", null), true);
  assert.equal(rendererOwnsAutoDismissPause(false, "tracking", null), true);
  assert.equal(rendererOwnsAutoDismissPause(false, "settling", null), true);
  assert.equal(rendererOwnsAutoDismissPause(false, "idle", "copy"), true);
  assert.equal(rendererOwnsAutoDismissPause(false, "idle", "save"), true);
  assert.equal(rendererOwnsAutoDismissPause(false, "idle", "dismiss"), true);
  assert.equal(rendererOwnsAutoDismissPause(false, "idle", "drag"), false);
});

test("a restored preview requests native reveal only after its pixels are ready", () => {
  assert.equal(shouldRequestOverlayReveal(false, false, false, true, false), false);
  assert.equal(shouldRequestOverlayReveal(true, true, false, true, false), false);
  assert.equal(shouldRequestOverlayReveal(true, false, true, true, false), false);
  assert.equal(shouldRequestOverlayReveal(true, false, false, false, false), false);
  assert.equal(shouldRequestOverlayReveal(true, false, false, true, true), false);
  assert.equal(shouldRequestOverlayReveal(true, false, false, true, false), true);
});

test("a hard-hidden DOM commits for two frames before warming the exact native surface", async () => {
  const scheduler = new FakeFrameScheduler();
  const phases: string[] = [];
  const identity = { surfaceGeneration: 41 };

  scheduleOverlayDomHiddenAcknowledgement(
    identity,
    () => true,
    () => phases.push("conceal"),
    async (target) => {
      phases.push(`ack:${target.surfaceGeneration}`);
      return true;
    },
    () => phases.push("warm"),
    scheduler,
  );

  assert.deepEqual(phases, ["conceal"]);
  scheduler.flushFrame();
  assert.deepEqual(phases, ["conceal"]);
  scheduler.flushFrame();
  assert.deepEqual(phases, ["conceal", "ack:41"]);
  await Promise.resolve();
  assert.deepEqual(phases, ["conceal", "ack:41", "warm"]);
});

test("a replaced hard-hidden surface cancels its queued warm acknowledgement", () => {
  const scheduler = new FakeFrameScheduler();
  const acknowledged: number[] = [];
  let currentGeneration = 8;
  const cancel = scheduleOverlayDomHiddenAcknowledgement(
    { surfaceGeneration: 8 },
    () => currentGeneration === 8,
    () => undefined,
    async (target) => {
      acknowledged.push(target.surfaceGeneration);
      return true;
    },
    () => undefined,
    scheduler,
  );

  scheduler.flushFrame();
  currentGeneration = 9;
  cancel();
  scheduler.flushFrame();
  assert.deepEqual(acknowledged, []);
});

test("a delayed native surface event cannot roll the renderer back", () => {
  assert.equal(shouldAcceptOverlaySurfaceGeneration(42, 41), false);
  assert.equal(shouldAcceptOverlaySurfaceGeneration(42, 42), true);
  assert.equal(shouldAcceptOverlaySurfaceGeneration(42, 43), true);
});

test("a delayed image decode cannot reveal a restored generation", () => {
  const originalDecode = { presentation: 12, surfaceGeneration: 41 };
  const restoredSurface = { presentation: 13, surfaceGeneration: 43 };

  assert.equal(isExactOverlayRendererIdentity(restoredSurface, originalDecode), false);
  assert.equal(
    isExactOverlayRendererIdentity(restoredSurface, {
      presentation: 13,
      surfaceGeneration: 42,
    }),
    false,
  );
  assert.equal(isExactOverlayRendererIdentity(restoredSurface, restoredSurface), true);
});

test("a native not-shown response waits for hidden restore without retrying", async () => {
  let attempts = 0;
  let waits = 0;
  const result = await requestNativeOverlayRevealWithRetry(
    async () => {
      attempts += 1;
      return false;
    },
    () => true,
    async () => {
      waits += 1;
    },
    3,
  );

  assert.equal(result, "not_shown");
  assert.equal(attempts, 1);
  assert.equal(waits, 0);
});

test("native reveal retries bounded IPC errors before showing", async () => {
  let attempts = 0;
  let waits = 0;
  const result = await requestNativeOverlayRevealWithRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("native bridge busy");
      return true;
    },
    () => true,
    async () => {
      waits += 1;
    },
    3,
  );

  assert.equal(result, "shown");
  assert.equal(attempts, 3);
  assert.equal(waits, 2);
});

test("paint acknowledgement waits for two frames and keeps the exact presentation identity", async () => {
  const scheduler = new FakeFrameScheduler();
  const phases: string[] = [];
  const acknowledgements: Array<{ path: string; presentationId: number; presentation: number }> = [];
  const identity = {
    path: "/tmp/capso/current.png",
    presentationId: 17,
    presentation: 4,
    surfaceGeneration: 9,
    reducedMotion: false,
  };

  scheduleOverlayPaintAcknowledgement(
    identity,
    () => true,
    () => phases.push("reveal"),
    (target) => {
      phases.push("acknowledge");
      acknowledgements.push(target);
      return Promise.resolve(true);
    },
    () => phases.push("confirmed"),
    scheduler,
  );

  assert.deepEqual(acknowledgements, []);
  scheduler.flushFrame();
  assert.deepEqual(phases, ["reveal"]);
  assert.deepEqual(acknowledgements, []);
  scheduler.flushFrame();
  assert.deepEqual(phases, ["reveal", "acknowledge"]);
  assert.deepEqual(acknowledgements, [identity]);
  await Promise.resolve();
  assert.deepEqual(phases, ["reveal", "acknowledge", "confirmed"]);
});

test("replacement or cancellation invalidates an older queued paint acknowledgement", () => {
  const scheduler = new FakeFrameScheduler();
  const acknowledgements: number[] = [];
  let currentPresentation = 1;
  const schedule = (presentation: number) => scheduleOverlayPaintAcknowledgement(
    {
      path: "/tmp/capso/repeated.png",
      presentationId: presentation,
      presentation,
      surfaceGeneration: presentation,
      reducedMotion: false,
    },
    () => currentPresentation === presentation,
    () => undefined,
    (target) => {
      acknowledgements.push(target.presentation);
      return Promise.resolve(true);
    },
    () => undefined,
    scheduler,
  );

  schedule(1);
  scheduler.flushFrame();
  currentPresentation = 2;
  scheduler.flushFrame();
  assert.deepEqual(acknowledgements, []);

  const cancelReplacement = schedule(2);
  scheduler.flushFrame();
  cancelReplacement();
  scheduler.flushFrame();
  assert.deepEqual(acknowledgements, []);
});

test("a late native paint response cannot confirm a replacement presentation", async () => {
  const scheduler = new FakeFrameScheduler();
  let currentPresentation = 1;
  let resolveAcknowledgement: ((value: boolean) => void) | undefined;
  const confirmed: number[] = [];
  const cancel = scheduleOverlayPaintAcknowledgement(
    {
      path: "/tmp/capso/repeated.png",
      presentationId: 1,
      presentation: 1,
      surfaceGeneration: 1,
      reducedMotion: true,
    },
    () => currentPresentation === 1,
    () => undefined,
    () => new Promise<boolean>((resolve) => {
      resolveAcknowledgement = resolve;
    }),
    (target) => confirmed.push(target.presentation),
    scheduler,
  );

  scheduler.flushFrame();
  scheduler.flushFrame();
  currentPresentation = 2;
  cancel();
  resolveAcknowledgement?.(true);
  await Promise.resolve();

  assert.deepEqual(confirmed, []);
});

test("false and rejected paint acknowledgements retry only to one bounded terminal cleanup", async () => {
  const scheduler = new FakeFrameScheduler();
  const identity = {
    path: "/tmp/capso/current.png",
    presentationId: 31,
    presentation: 8,
    surfaceGeneration: 12,
    reducedMotion: false,
  };
  let attempts = 0;
  let waits = 0;
  const failures: typeof identity[] = [];

  scheduleOverlayPaintAcknowledgement(
    identity,
    () => true,
    () => undefined,
    async () => {
      attempts += 1;
      if (attempts === 2) throw new Error("paint bridge unavailable");
      return false;
    },
    () => undefined,
    scheduler,
    {
      maxAttempts: 3,
      wait: async () => {
        waits += 1;
      },
      onFailed: (failed) => failures.push(failed),
    },
  );

  scheduler.flushFrame();
  scheduler.flushFrame();
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();

  assert.equal(attempts, 3);
  assert.equal(waits, 2);
  assert.deepEqual(failures, [identity]);
});

test("paint retry cancellation cannot clean up a replacement presentation", async () => {
  const scheduler = new FakeFrameScheduler();
  const identity = {
    path: "/tmp/capso/old.png",
    presentationId: 40,
    presentation: 9,
    surfaceGeneration: 14,
    reducedMotion: true,
  };
  let current = true;
  let attempts = 0;
  let waits = 0;
  let releaseWait: (() => void) | undefined;
  const failures: number[] = [];

  scheduleOverlayPaintAcknowledgement(
    identity,
    () => current,
    () => undefined,
    async () => {
      attempts += 1;
      return false;
    },
    () => undefined,
    scheduler,
    {
      maxAttempts: 3,
      wait: () => new Promise<void>((resolve) => {
        waits += 1;
        releaseWait = resolve;
      }),
      onFailed: (failed) => failures.push(failed.presentation),
    },
  );

  scheduler.flushFrame();
  scheduler.flushFrame();
  await Promise.resolve();
  assert.equal(waits, 1);

  current = false;
  releaseWait?.();
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();

  assert.equal(attempts, 1);
  assert.deepEqual(failures, []);
});
