export type OverlayFileInfo = {
  format: "PNG";
  bytes: number;
  capturedAtMs: number;
};

export function overlayFileSize(bytes: number): string {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return "Size unavailable";
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.round(bytes / 1_024)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export function overlayCapturedAt(capturedAtMs: number): string {
  const date = new Date(capturedAtMs);
  if (!Number.isFinite(date.getTime())) return "Capture time unavailable";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
