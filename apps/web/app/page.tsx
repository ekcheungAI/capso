import { filed } from "@/lib/mock";
import { FilterPill, Masonry } from "@/components/ui";

/** Library: filter row above a masonry grid, grouped by month (see note in groupByMonth). */
export default function LibraryPage() {
  const groups = groupByMonth(filed);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <FilterPill label="Any intent ▾" />
        <FilterPill label="Any project ▾" />
        <FilterPill label="Any date ▾" />
        <span className="ml-auto text-xs text-muted">{filed.length} captures</span>
      </div>

      {groups.map(([day, items]) => (
        <section key={day}>
          <h2 className="mb-3 text-xs font-medium text-muted">{day}</h2>
          <Masonry items={items} />
        </section>
      ))}
    </div>
  );
}

/**
 * Month, not day. Fabric groups by day because its users save dozens daily; at a
 * personal ~3/day that produces one card per header and destroys the grid density
 * the moodboard depends on.
 */
function groupByMonth(items: typeof filed) {
  const map = new Map<string, typeof filed>();
  for (const s of [...items].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))) {
    const month = new Date(s.capturedAt).toLocaleDateString("en-GB", {
      month: "long",
      year: "numeric",
    });
    map.set(month, [...(map.get(month) ?? []), s]);
  }
  return [...map.entries()];
}
