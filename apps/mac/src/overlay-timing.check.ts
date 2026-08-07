import assert from "node:assert/strict";
import test from "node:test";
import {
  PausableOverlayTimer,
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

test("hover pause preserves the exact remaining auto-dismiss duration", () => {
  const scheduler = new FakeScheduler();
  let dismissals = 0;
  const timer = new PausableOverlayTimer(8_000, () => dismissals++, scheduler);

  timer.start();
  scheduler.advance(3_000);
  timer.pause();
  assert.equal(timer.remainingMs(), 5_000);

  scheduler.advance(20_000);
  assert.equal(dismissals, 0);

  timer.start();
  scheduler.advance(4_999);
  assert.equal(dismissals, 0);
  scheduler.advance(1);
  assert.equal(dismissals, 1);
});

test("a new capture resets and invalidates the older capture timer", () => {
  const scheduler = new FakeScheduler();
  let dismissals = 0;
  const timer = new PausableOverlayTimer(8_000, () => dismissals++, scheduler);

  timer.start();
  scheduler.advance(7_000);
  timer.reset();
  timer.start();
  scheduler.advance(1_001);
  assert.equal(dismissals, 0);
  scheduler.advance(6_999);
  assert.equal(dismissals, 1);
});

test("an expired timeout remains one-shot until a new capture resets it", () => {
  const scheduler = new FakeScheduler();
  let dismissals = 0;
  const timer = new PausableOverlayTimer(8_000, () => dismissals++, scheduler);

  timer.start();
  scheduler.advance(8_000);
  assert.equal(dismissals, 1);

  timer.start();
  timer.start();
  assert.equal(dismissals, 1);

  timer.reset();
  timer.start();
  scheduler.advance(8_000);
  assert.equal(dismissals, 2);
});
