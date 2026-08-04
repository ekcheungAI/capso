/** Capture ids are UUIDs in the real store, so citations must retain hyphens. */
export const CITATION_TOKEN = /\[([A-Za-z0-9_-]+)\]/g;

export function extractCitedIds(text: string, supplied: Iterable<string>) {
  const allowed = new Set(supplied);
  return [...new Set([...text.matchAll(CITATION_TOKEN)].map((match) => match[1]!))].filter((id) =>
    allowed.has(id),
  );
}

export function citationId(token: string) {
  return /^\[([A-Za-z0-9_-]+)\]$/.exec(token)?.[1] ?? null;
}
