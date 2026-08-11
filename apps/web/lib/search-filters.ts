import { INTENTS } from "./intent.ts";

export type SearchDate = "any" | "30d" | "year";
export type SearchFilters = {
  q: string;
  project: string;
  intent: string;
  date: SearchDate;
};

const INTENT_SET = new Set<string>(INTENTS);
const DATES = new Set<SearchDate>(["any", "30d", "year"]);

export const EMPTY_SEARCH_FILTERS: SearchFilters = { q: "", project: "", intent: "", date: "any" };

function bounded(value: string | null, max: number): string {
  return (value ?? "").trim().slice(0, max);
}

export function parseSearchFilters(search: string): SearchFilters {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const intent = bounded(params.get("intent"), 64);
  const rawDate = bounded(params.get("date"), 16) as SearchDate;
  return {
    q: bounded(params.get("q"), 500),
    project: bounded(params.get("project"), 128),
    intent: INTENT_SET.has(intent) ? intent : "",
    date: DATES.has(rawDate) ? rawDate : "any",
  };
}

export function serializeSearchFilters(filters: SearchFilters): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.project) params.set("project", filters.project);
  if (filters.intent) params.set("intent", filters.intent);
  if (filters.date !== "any") params.set("date", filters.date);
  return params.toString();
}

export function matchesSearchFilters(
  screenshot: { threadId: string | null; intent: string; capturedAt: string },
  filters: SearchFilters,
  now = Date.now(),
): boolean {
  if (filters.project && screenshot.threadId !== filters.project) return false;
  if (filters.intent && screenshot.intent !== filters.intent) return false;
  if (filters.date === "any") return true;

  const captured = new Date(screenshot.capturedAt).getTime();
  if (!Number.isFinite(captured)) return false;
  if (filters.date === "30d") return captured >= now - 30 * 86_400_000 && captured <= now;
  return new Date(captured).getFullYear() === new Date(now).getFullYear();
}
