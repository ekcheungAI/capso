import { screenshots, threadName } from "@/lib/mock";
import { FilterPill, Masonry } from "@/components/ui";

/**
 * Search results for the query "pricing page I saved in March".
 * The extracted date filter echoes back as a removable pill (GoFundMe/Unity) —
 * an auto-applied filter the user cannot see is an auto-applied filter they cannot undo.
 */
export default function SearchPage() {
  const query = "pricing page I saved in March";
  const results = screenshots.filter((s) => s.capturedAt.startsWith("2026-03"));

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-line bg-surface px-4 py-2.5 text-sm">{query}</div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">Understood as</span>
        <FilterPill label="March 2026" removable />
        <FilterPill label="semantic: pricing page" removable />
        <button className="text-xs text-muted underline underline-offset-2">Reset</button>
        <span className="ml-auto text-xs text-muted">{results.length} results</span>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1">
        {["Competitor", "Design inspiration", "UX bug", "Marketing hook", "Reference"].map((c) => (
          <FilterPill key={c} label={c} />
        ))}
      </div>

      {/* Match reason rides on the card. A separate result list beside the grid
          is the same information twice and doubles the scan cost. */}
      <Masonry
        items={results}
        noteFor={(s) =>
          `${threadName(s.threadId ?? "")} · matched OCR “${s.ocrExcerpt.slice(0, 40)}…”`
        }
      />
    </div>
  );
}
