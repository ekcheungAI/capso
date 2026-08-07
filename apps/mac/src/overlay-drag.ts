export class OverlayDragGesture {
  private active: { pointerId: number; x: number; y: number; started: boolean } | null = null;
  private readonly threshold: number;

  constructor(threshold: number) {
    this.threshold = threshold;
  }

  begin(pointerId: number, x: number, y: number) {
    this.active = { pointerId, x, y, started: false };
  }

  move(pointerId: number, x: number, y: number) {
    const active = this.active;
    if (!active || active.pointerId !== pointerId || active.started) return false;
    const distance = Math.hypot(x - active.x, y - active.y);
    if (distance < this.threshold) return false;
    active.started = true;
    return true;
  }

  end(pointerId: number) {
    if (this.active?.pointerId === pointerId) this.active = null;
  }

  reset() {
    this.active = null;
  }
}

export function suggestedCaptureFilename(now = new Date()) {
  const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0"))
    .join("-");
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(".");
  return `Capso ${date} at ${time}.png`;
}
