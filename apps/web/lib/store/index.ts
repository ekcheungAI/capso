import { idb } from "./db";
import { seedScreenshots, seedThreads } from "./seed";
import type { Correction, Revisit, Screenshot, Thread } from "./types";

export * from "./types";
export { placeholder } from "./placeholder";

/**
 * Data layer seam. Every function here has a one-to-one Supabase equivalent in
 * P1 (see specs/api_contracts.md) — the UI never talks to IndexedDB directly.
 */

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export async function loadAll() {
  let threads = await idb.all<Thread>("threads");
  let screenshots = await idb.all<Screenshot>("screenshots");

  if (threads.length === 0 && screenshots.length === 0) {
    await Promise.all(seedThreads.map((t) => idb.put("threads", t)));
    await Promise.all(seedScreenshots.map((s) => idb.put("screenshots", s)));
    threads = seedThreads;
    screenshots = seedScreenshots;
  }

  const [corrections, revisits] = await Promise.all([
    idb.all<Correction>("corrections"),
    idb.all<Revisit>("revisits"),
  ]);

  return { threads, screenshots, corrections, revisits };
}

export async function resetAll() {
  await Promise.all([
    idb.clear("threads"),
    idb.clear("screenshots"),
    idb.clear("corrections"),
    idb.clear("revisits"),
  ]);
  return loadAll();
}

export async function putScreenshot(s: Screenshot) {
  await idb.put("screenshots", s);
  return s;
}

export async function putThread(t: Thread) {
  await idb.put("threads", t);
  return t;
}

export async function createThread(name: string): Promise<Thread> {
  const now = new Date().toISOString();
  return putThread({ id: uid(), name, createdAt: now, lastActiveAt: now, archived: false });
}

/**
 * Assign (or re-assign) a screenshot to a thread. Always writes a correction row
 * — both accepts and overrides feed the few-shot window (06 §6). `wasAiAccepted`
 * is what separates the two.
 */
export async function assignThread(
  s: Screenshot,
  threadId: string | null,
  source: Screenshot["assignmentSource"],
): Promise<{ screenshot: Screenshot; correction: Correction }> {
  const aiValue = s.suggestedThreadId ?? null;
  const next: Screenshot = { ...s, threadId, assignmentSource: source };

  const correction: Correction = {
    id: uid(),
    screenshotId: s.id,
    field: "project",
    aiValue,
    userValue: threadId ?? "inbox",
    wasAiAccepted: aiValue !== null && aiValue === threadId,
    createdAt: new Date().toISOString(),
  };

  await Promise.all([idb.put("screenshots", next), idb.put("corrections", correction)]);

  if (threadId) {
    const t = await idb.get<Thread>("threads", threadId);
    if (t) await idb.put("threads", { ...t, lastActiveAt: new Date().toISOString() });
  }

  return { screenshot: next, correction };
}

/** Editing why_saved is a training signal too — owner decision, overrides 06 §5. */
export async function editWhySaved(s: Screenshot, whySaved: string) {
  const next = { ...s, whySaved };
  const correction: Correction = {
    id: uid(),
    screenshotId: s.id,
    field: "why_saved",
    aiValue: s.whySaved,
    userValue: whySaved,
    wasAiAccepted: false,
    createdAt: new Date().toISOString(),
  };
  await Promise.all([idb.put("screenshots", next), idb.put("corrections", correction)]);
  return { screenshot: next, correction };
}

export async function setIntent(s: Screenshot, intent: Screenshot["intent"]) {
  const next = { ...s, intent };
  const correction: Correction = {
    id: uid(),
    screenshotId: s.id,
    field: "intent",
    aiValue: s.intent,
    userValue: intent,
    wasAiAccepted: s.intent === intent,
    createdAt: new Date().toISOString(),
  };
  await Promise.all([idb.put("screenshots", next), idb.put("corrections", correction)]);
  return { screenshot: next, correction };
}

/** Hard delete, per F10 — image, rows and derived data all go. */
export async function deleteScreenshot(s: Screenshot) {
  await idb.del("screenshots", s.id);
  const [corrections, revisits] = await Promise.all([
    idb.all<Correction>("corrections"),
    idb.all<Revisit>("revisits"),
  ]);
  await Promise.all([
    ...corrections.filter((c) => c.screenshotId === s.id).map((c) => idb.del("corrections", c.id)),
    ...revisits.filter((r) => r.screenshotId === s.id).map((r) => idb.del("revisits", r.id)),
  ]);
}

export async function recordRevisit(screenshotId: string, kind: Revisit["kind"]) {
  const r: Revisit = { id: uid(), screenshotId, kind, createdAt: new Date().toISOString() };
  await idb.put("revisits", r);
  return r;
}


export function newId() {
  return uid();
}

/** Confidence bands from 09_AI_SYSTEM_AND_MODEL_ROUTING.md (mirrors packages/shared). */
export function routeConfidence(c: number): "auto" | "suggest" | "inbox" {
  if (c >= 0.8) return "auto";
  if (c >= 0.5) return "suggest";
  return "inbox";
}
