export function defaultSearchCandidates<T extends { archived: boolean; capturedAt: string }>(
  screenshots: readonly T[],
): T[] {
  return screenshots
    .filter((screenshot) => !screenshot.archived)
    .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
}

export function searchOrderLabel(ranked: boolean): string {
  return ranked ? "sorted by relevance" : "sorted newest first";
}
