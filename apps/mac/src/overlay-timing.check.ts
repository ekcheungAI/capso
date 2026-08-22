import assert from "node:assert/strict";
import test from "node:test";
import {
  createOverlayAutoDismissTimer,
  NativeOverlayAutoDismissBridge,
  PausableOverlayTimer,
  rendererOwnsAutoDismissPause,
  shouldRequestOverlayReveal,
  type OverlayAutoDismissIdentity,
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
  };
  const calls: string[] = [];
  let releasePause: (() => void) | undefined;
  let markPauseStarted: (() => void) | undefined;
  const pauseStarted = new Promise<void>((resolve) => {
    markPauseStarted = resolve;
  });
  const bridge = new NativeOverlayAutoDismissBridge(async (target, paused) => {
    calls.push(`${target.presentationId}:${paused ? "pause" : "resume"}`);
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
  assert.deepEqual(calls, ["7:pause"]);

  releasePause?.();
  assert.equal(await pause, true);
  assert.equal(await resume, true);
  assert.deepEqual(calls, ["7:pause", "7:resume"]);
});

test("native pause failures do not poison later exact-presentation updates", async () => {
  const first: OverlayAutoDismissIdentity = {
    path: "/tmp/capso/repeated.png",
    presentationId: 1,
  };
  const replacement: OverlayAutoDismissIdentity = {
    path: "/tmp/capso/repeated.png",
    presentationId: 2,
  };
  const calls: string[] = [];
  const bridge = new NativeOverlayAutoDismissBridge(async (target, paused) => {
    calls.push(`${target.presentationId}:${paused ? "pause" : "resume"}`);
    if (target.presentationId === 1) throw new Error("renderer disappeared");
    return true;
  });

  assert.equal(await bridge.setPaused(first, true), false);
  assert.equal(await bridge.setPaused(replacement, false), true);
  assert.deepEqual(calls, ["1:pause", "2:resume"]);
});

test("renderer owns pointer, action, and swipe pauses but not native drag", () => {
  assert.equal(rendererOwnsAutoDismissPause(false, "idle", null), false);
  assert.equal(rendererOwnsAutoDismissPause(true, "idle", null), true);
  assert.equal(rendererOwnsAutoDismissPause(false, "tracking", null), true);
  assert.equal(rendererOwnsAutoDismissPause(false, "settling", null), true);
  assert.equal(rendererOwnsAutoDismissPause(false, "idle", "copy"), true);
  assert.equal(rendererOwnsAutoDismissPause(false, "idle", "save"), true);
  assert.equal(rendererOwnsAutoDismissPause(false, "idle", "dismiss"), true);
  assert.equal(rendererOwnsAutoDismissPause(false, "idle", "drag"), false);
});

test("a restored preview requests native reveal only after its pixels are ready", () => {
  assert.equal(shouldRequestOverlayReveal(false, false, false, false), false);
  assert.equal(shouldRequestOverlayReveal(true, true, false, false), false);
  assert.equal(shouldRequestOverlayReveal(true, false, true, false), false);
  assert.equal(shouldRequestOverlayReveal(true, false, false, true), false);
  assert.equal(shouldRequestOverlayReveal(true, false, false, false), true);
});
