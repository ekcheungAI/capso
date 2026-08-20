import type { Correction, Screenshot } from "./store/types.ts";

export type MemoryRule = {
  target: string;
  correctionCount: number;
  exampleIds: string[];
  intents: Screenshot["intent"][];
};

export type MemoryRuleSummary = {
  accepted: number;
  total: number;
  acceptanceRate: number | null;
  contextUsed: number;
  rules: MemoryRule[];
};

/** Derives every visible learning claim from the correction ledger itself. */
export function memoryRuleSummary(
  corrections: readonly Correction[],
  screenshots: readonly Pick<Screenshot, "id" | "intent">[],
): MemoryRuleSummary {
  const projectCorrections = corrections.filter((correction) => correction.field === "project");
  const accepted = projectCorrections.filter((correction) => correction.wasAiAccepted).length;
  const shotsById = new Map(screenshots.map((screenshot) => [screenshot.id, screenshot]));
  const byTarget = new Map<string, MemoryRule>();

  for (const correction of [...projectCorrections]
    .filter((candidate) => !candidate.wasAiAccepted)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const rule = byTarget.get(correction.userValue) ?? {
      target: correction.userValue,
      correctionCount: 0,
      exampleIds: [],
      intents: [],
    };
    rule.correctionCount += 1;

    const screenshot = shotsById.get(correction.screenshotId);
    if (screenshot && !rule.exampleIds.includes(screenshot.id)) {
      rule.exampleIds.push(screenshot.id);
    }
    if (screenshot && !rule.intents.includes(screenshot.intent)) {
      rule.intents.push(screenshot.intent);
    }
    byTarget.set(correction.userValue, rule);
  }

  const total = projectCorrections.length;
  return {
    accepted,
    total,
    acceptanceRate: total === 0 ? null : Math.round((accepted / total) * 100),
    contextUsed: Math.min(total, 20),
    rules: [...byTarget.values()].sort(
      (a, b) => b.correctionCount - a.correctionCount || a.target.localeCompare(b.target),
    ),
  };
}
