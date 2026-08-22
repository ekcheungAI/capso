export type OverlaySwipeSample = {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  directionInvertedFromDevice: boolean;
};

export type OverlaySwipeResult =
  | { kind: "ignored" }
  | { kind: "tracking"; offsetX: number }
  | { kind: "dismiss"; offsetX: number };

type SwipePhase = "idle" | "tracking" | "rejected" | "dismissed";

export class OverlaySwipeGesture {
  private phase: SwipePhase = "idle";
  private offsetX = 0;

  move(sample: OverlaySwipeSample, width: number): OverlaySwipeResult {
    if (this.phase === "rejected" || this.phase === "dismissed") {
      return { kind: "ignored" };
    }

    const deltaX = sample.directionInvertedFromDevice ? -sample.deltaX : sample.deltaX;
    const isPixelGesture = sample.deltaMode === 0;
    const isFiniteGesture =
      Number.isFinite(deltaX) &&
      Number.isFinite(sample.deltaY) &&
      Number.isFinite(width) &&
      width > 0;

    if (this.phase === "idle") {
      const startsRightward = deltaX > 0;
      const startsHorizontally = Math.abs(deltaX) >= Math.abs(sample.deltaY) * 1.35;

      if (!isPixelGesture || !isFiniteGesture || !startsRightward || !startsHorizontally) {
        this.phase = "rejected";
        return { kind: "ignored" };
      }

      this.phase = "tracking";
    }

    this.offsetX = Math.max(0, this.offsetX + deltaX);
    const dismissThreshold = Math.min(96, width * 0.25);

    if (this.offsetX >= dismissThreshold) {
      this.phase = "dismissed";
      return { kind: "dismiss", offsetX: this.offsetX };
    }

    return { kind: "tracking", offsetX: this.offsetX };
  }

  offset(): number {
    return this.offsetX;
  }

  reset(): void {
    this.phase = "idle";
    this.offsetX = 0;
  }
}
