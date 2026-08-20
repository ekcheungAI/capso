export const ANNOTATION_CUSTOM_COLORS_KEY = "capso-annotation-custom-colors-v1";
export const MAX_ANNOTATION_CUSTOM_COLORS = 8;
const MAX_STORED_COLOR_BYTES = 256;

export type AnnotationColorStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export function isAnnotationHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function normalizeColors(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const colors: string[] = [];
  for (const candidate of value) {
    if (!isAnnotationHexColor(candidate)) continue;
    const normalized = candidate.toLowerCase();
    if (!colors.includes(normalized)) colors.push(normalized);
    if (colors.length === MAX_ANNOTATION_CUSTOM_COLORS) break;
  }
  return colors;
}

export function readAnnotationCustomColors(storage: AnnotationColorStorage): string[] {
  try {
    const raw = storage.getItem(ANNOTATION_CUSTOM_COLORS_KEY);
    if (!raw || new TextEncoder().encode(raw).byteLength > MAX_STORED_COLOR_BYTES) return [];
    return normalizeColors(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function saveAnnotationCustomColor(
  storage: AnnotationColorStorage,
  current: string[],
  color: string,
): string[] {
  if (!isAnnotationHexColor(color)) return normalizeColors(current);
  const normalized = color.toLowerCase();
  const next = [normalized, ...normalizeColors(current).filter((candidate) => candidate !== normalized)]
    .slice(0, MAX_ANNOTATION_CUSTOM_COLORS);
  try {
    storage.setItem(ANNOTATION_CUSTOM_COLORS_KEY, JSON.stringify(next));
    return next;
  } catch {
    return normalizeColors(current);
  }
}
