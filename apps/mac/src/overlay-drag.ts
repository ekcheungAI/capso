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

export type OverlaySaveAsPreferences = {
  format: "png" | "jpeg";
  filenameTemplate: string;
};

const DEFAULT_SAVE_AS_PREFERENCES: OverlaySaveAsPreferences = {
  format: "png",
  filenameTemplate: "Capso {date} at {time}",
};

export function saveAsTemplateError(template: string) {
  const trimmed = template.trim();
  if (
    !trimmed ||
    new TextEncoder().encode(trimmed).byteLength > 96 ||
    trimmed.startsWith(".") ||
    /[\\/:\u0000-\u001f\u007f]/u.test(trimmed)
  ) {
    return "Use 1–96 safe characters and do not start with a dot.";
  }
  const remainder = trimmed.split("{date}").join("").split("{time}").join("");
  if (remainder.includes("{") || remainder.includes("}")) {
    return "Only {date} and {time} are supported.";
  }
  return null;
}

export function saveAsFilters(preferred: OverlaySaveAsPreferences["format"]) {
  const png = { name: "PNG image", extensions: ["png"] };
  const jpeg = { name: "JPEG image", extensions: ["jpg", "jpeg"] };
  return preferred === "jpeg" ? [jpeg, png] : [png, jpeg];
}

export function suggestedCaptureFilename(
  now = new Date(),
  preferences = DEFAULT_SAVE_AS_PREFERENCES,
) {
  const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0"))
    .join("-");
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(".");
  const name = preferences.filenameTemplate
    .split("{date}").join(date)
    .split("{time}").join(time)
    .trim();
  const extension = preferences.format === "jpeg" ? "jpg" : "png";
  return `${name}.${extension}`;
}
