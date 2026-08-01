import { idb } from "./db";
import { seedScreenshots, seedThreads } from "./seed";
import { roleById } from "@/lib/templates";
import { routeByConfidence } from "@capso/shared";
import { withScreenshotDefaults } from "./types";
import type { Correction, Message, Revisit, Screenshot, Thread } from "./types";

export * from "./types";
export { placeholder } from "./placeholder";

/**
 * Data layer seam. Every function here has a one-to-one Supabase equivalent in
 * P1 (see specs/api_contracts.md) — the UI never talks to IndexedDB directly.
 */

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * How this library came to exist. Its presence — not the DB being non-empty —
 * is what decides whether the first-run picker shows, so a user who picks
 * "Start empty" or deletes everything is never asked to choose again.
 */
const SETUP = "capso.setup";
type Setup = "template" | "samples" | "empty";

/** Threads written before descriptions existed read back without the field. */
const withDescription = (t: Thread): Thread => ({ ...t, description: t.description ?? "" });

export async function loadAll() {
  const [rawThreads, rawScreenshots, corrections, revisits, messages] = await Promise.all([
    idb.all<Thread>("threads"),
    idb.all<Screenshot>("screenshots"),
    idb.all<Correction>("corrections"),
    idb.all<Revisit>("revisits"),
    idb.all<Message>("messages"),
  ]);

  const threads = rawThreads.map(withDescription);
  const screenshots = rawScreenshots.map(withScreenshotDefaults);
  let setup = localStorage.getItem(SETUP) as Setup | null;

  // Libraries that predate the picker are already set up by definition — never
  // interrupt an existing collection to ask what kind of person you are.
  if (!setup && (threads.length > 0 || screenshots.length > 0)) {
    setup = "template";
    localStorage.setItem(SETUP, setup);
  }

  return { threads, screenshots, corrections, revisits, messages, needsSetup: setup === null };
}

/**
 * Create the starter projects for a role. Empty role = a deliberate blank start.
 * All of them share one `lastActiveAt` and are spaced by a millisecond of
 * `createdAt`, so the library lists a fresh template in the order the picker
 * promised instead of whatever order five writes happened to finish in.
 */
export async function applyTemplate(roleId: string) {
  const role = roleById(roleId);
  const now = Date.now();

  for (const [i, p] of (role?.projects ?? []).entries()) {
    await putThread({
      id: uid(),
      name: p.name,
      description: p.description,
      createdAt: new Date(now + i).toISOString(),
      lastActiveAt: new Date(now).toISOString(),
      archived: false,
    });
  }

  localStorage.setItem(SETUP, "template");
  return loadAll();
}

/** The first-run fixtures, now opt-in rather than automatic. */
export async function loadSamples() {
  await Promise.all(seedThreads.map((t) => idb.put("threads", t)));
  await Promise.all(seedScreenshots.map((s) => idb.put("screenshots", s)));
  localStorage.setItem(SETUP, "samples");
  return loadAll();
}

export async function resetAll() {
  localStorage.removeItem(SETUP);
  await Promise.all([
    idb.clear("threads"),
    idb.clear("screenshots"),
    idb.clear("corrections"),
    idb.clear("revisits"),
    idb.clear("messages"),
  ]);
  return loadAll();
}

/**
 * "Use my own screenshots" — drops the first-run fixtures and keeps everything
 * real. A seeded project survives if real captures were filed into it; its chat
 * history goes with it if it does not.
 */
export async function clearSamples() {
  const [screenshots, threads, messages] = await Promise.all([
    idb.all<Screenshot>("screenshots"),
    idb.all<Thread>("threads"),
    idb.all<Message>("messages"),
  ]);

  await Promise.all(screenshots.filter((s) => s.source === "seed").map(deleteScreenshot));

  const seedIds = new Set(seedThreads.map((t) => t.id));
  const inUse = new Set(
    screenshots.filter((s) => s.source !== "seed").map((s) => s.threadId),
  );
  const dropped = threads.filter((t) => seedIds.has(t.id) && !inUse.has(t.id));

  await Promise.all([
    ...dropped.map((t) => idb.del("threads", t.id)),
    ...messages
      .filter((m) => dropped.some((t) => t.id === m.threadId))
      .map((m) => idb.del("messages", m.id)),
  ]);

  localStorage.setItem(SETUP, "empty");
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

export async function createThread(name: string, description = ""): Promise<Thread> {
  const now = new Date().toISOString();
  return putThread({
    id: uid(),
    name,
    description,
    createdAt: now,
    lastActiveAt: now,
    archived: false,
  });
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
): Promise<{ screenshot: Screenshot; correction: Correction; thread?: Thread }> {
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

  // Returned so the caller can refresh it in memory — the library orders project
  // shelves by recency, and a drop that did not visibly move its shelf reads as
  // if nothing happened.
  let thread: Thread | undefined;
  if (threadId) {
    const t = await idb.get<Thread>("threads", threadId);
    if (t) {
      thread = withDescription({ ...t, lastActiveAt: new Date().toISOString() });
      await idb.put("threads", thread);
    }
  }

  return { screenshot: next, correction, thread };
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

/**
 * Add a tag the owner typed. Lands in `userTags`, never in `tags` — the two
 * lists are the whole "AI suggests, user confirms" contract made concrete, and
 * merging them would erase who said what.
 *
 * Adding is not a correction: the owner is volunteering information, not
 * disagreeing with a guess. Only removals below train the model.
 */
export async function addUserTag(s: Screenshot, raw: string) {
  const tag = raw.trim().toLowerCase().replace(/^#/, "").slice(0, 40);
  // Already known — whether the model proposed it or the owner typed it before.
  if (!tag || s.userTags.includes(tag) || s.tags.includes(tag)) return { screenshot: s };

  const next = { ...s, userTags: [...s.userTags, tag] };
  await idb.put("screenshots", next);
  return { screenshot: next };
}

/**
 * Remove a tag from either list. Dropping an AI tag is a rejection and writes a
 * correction so /memory can show it back and the few-shot window can learn from
 * it; dropping one of your own is just an edit.
 */
export async function removeTag(s: Screenshot, tag: string) {
  const wasAi = s.tags.includes(tag);
  const next: Screenshot = {
    ...s,
    tags: s.tags.filter((t) => t !== tag),
    userTags: s.userTags.filter((t) => t !== tag),
  };

  if (!wasAi) {
    await idb.put("screenshots", next);
    return { screenshot: next };
  }

  const correction: Correction = {
    id: uid(),
    screenshotId: s.id,
    field: "tags",
    aiValue: tag,
    userValue: "",
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

/**
 * Confidence bands from 09_AI_SYSTEM_AND_MODEL_ROUTING.md. Re-exported rather
 * than reimplemented — this used to hardcode 0.8/0.5 alongside the same
 * thresholds in `packages/shared`, which is two places to drift.
 */
export const routeConfidence = routeByConfidence;

/** Archiving keeps the record but drops it out of the library, search and centroids. */
export async function setArchived(s: Screenshot, archived: boolean) {
  const next = { ...s, archived };
  await idb.put("screenshots", next);
  return next;
}

/** "Forget this" — removing a correction removes it from the few-shot window. */
export async function forgetCorrection(id: string) {
  await idb.del("corrections", id);
}

export async function addMessage(m: Omit<Message, "id" | "createdAt">): Promise<Message> {
  const msg: Message = { ...m, id: uid(), createdAt: new Date().toISOString() };
  await idb.put("messages", msg);
  return msg;
}
