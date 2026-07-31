import type { Screenshot } from "./types";

/** Deterministic stand-in thumbnail for seeded fixtures that carry no real image. */
export function placeholder(s: Pick<Screenshot, "hue" | "aspect">): string {
  const h = s.hue;
  const height = s.aspect === "tall" ? 420 : s.aspect === "wide" ? 200 : 300;
  const rows = Array.from({ length: Math.floor(height / 46) }, (_, i) => {
    const w = 190 - ((i * 37) % 110);
    return `<rect x="18" y="${64 + i * 46}" width="${w}" height="12" rx="6" fill="hsl(${h} 22% 62% / 0.5)"/>
      <rect x="18" y="${82 + i * 46}" width="${w - 40}" height="8" rx="4" fill="hsl(${h} 18% 66% / 0.32)"/>`;
  }).join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="${height}" viewBox="0 0 320 ${height}">
    <rect width="320" height="${height}" fill="hsl(${h} 34% 94%)"/>
    <rect width="320" height="40" fill="hsl(${h} 40% 88%)"/>
    <circle cx="22" cy="20" r="5" fill="hsl(${h} 30% 70%)"/>
    <circle cx="40" cy="20" r="5" fill="hsl(${h} 30% 76%)"/>
    <circle cx="58" cy="20" r="5" fill="hsl(${h} 30% 82%)"/>
    <rect x="232" y="${height - 46}" width="70" height="26" rx="13" fill="hsl(${h} 55% 58%)"/>
    ${rows}
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
