import { backend, splitsOriginal } from "./backend";
import { isOwnCapture, onboardingStage } from "@/lib/onboarding";
import { uuidFromSeed } from "./map";
import { seedScreenshots, seedThreads } from "./seed";
import { roleById } from "@/lib/templates";
import { routeByConfidence } from "@capso/shared";
import { withScreenshotDefaults } from "./types";
import type { Correction, Message, Revisit, Screenshot, Thread } from "./types";

export * from "./types";
export { placeholder } from "./placeholder";

/**
 * Data layer seam. Every rule the product has about its data lives here; where
 * the data physically goes is `./backend.ts`, which resolves to Supabase when a
 * project is configured and reachable, and IndexedDB otherwise.
 *
 * The UI never talks to either backend directly, which is why swapping them
 * touched nothing under `app/` or `components/`.
 */

/**
 * Postgres `id` columns are `uuid`, so ids must be uuids on both backends — an
 * id minted locally has to stay valid if the same library later syncs.
 * IndexedDB does not care what the key looks like, so this is safe for existing
 * local libraries; their older ids keep working as keys.
 */
const uid = () => crypto.randomUUID();

/**
 * How this library came to exist. Its presence — not the DB being non-empty —
 * is what decides whether the first-run picker shows, so a user who picks
 * "Start empty" or deletes everything is never asked to choose again.
 */
const SETUP = "capso.setup";
type Setup = "template" | "samples" | "empty";

/**
 * Whether this person has ever captured anything of their own. A one-way latch,
 * deliberately separate from SETUP: SETUP records how the library began, this
 * records that onboarding is over. Once set it is never cleared except by a full
 * reset, so a user who captures and then deletes everything is not greeted as a
 * newcomer — that would read as the app having forgotten them.
 */
const FIRST_CAPTURE = "capso.firstCapture";

/** Threads written before descriptions existed read back without the field. */
const withDescription = (t: Thread): Thread => ({ ...t, description: t.description ?? "" });

/**
 * Fixture ids are hand-written and readable (`"s1"`, `"pricing-redesign"`), which
 * `uuid` columns reject. Mapped deterministically at the boundary rather than
 * rewritten in `seed.ts`, so the fixtures stay reviewable and a screenshot's
 * `threadId` still resolves to the thread of the same name. See `uuidFromSeed`.
 */
const seededThreads = (): Thread[] =>
  seedThreads.map((t) => ({ ...t, id: uuidFromSeed(t.id) }));

const seededScreenshots = (): Screenshot[] =>
  seedScreenshots.map((s) => ({
    ...s,
    id: uuidFromSeed(s.id),
    threadId: s.threadId ? uuidFromSeed(s.threadId) : null,
  }));

export async function loadAll() {
  const b = await backend();

  const [rawThreads, rawScreenshots, corrections, revisits, messages] = await Promise.all([
    b.all<Thread>("threads"),
    b.all<Screenshot>("screenshots"),
    b.all<Correction>("corrections"),
    b.all<Revisit>("revisits"),
    b.all<Message>("messages"),
  ]);

  const threads = rawThreads.map(withDescription);
  // Remote rows arrive with a storage path and no pixels; one batched signing
  // call gives the grid something to render. Local rows already carry their
  // thumb inline and pass through untouched.
  const screenshots = await b.hydrateThumbs(rawScreenshots.map(withScreenshotDefaults));

  let setup = localStorage.getItem(SETUP) as Setup | null;
  const libraryNotEmpty = threads.length > 0 || screenshots.length > 0;

  // Libraries that predate the picker are already set up by definition — never
  // interrupt an existing collection to ask what kind of person you are.
  if (!setup && libraryNotEmpty) {
    setup = "template";
    localStorage.setItem(SETUP, setup);
  }

  const ownCaptures = screenshots.filter(isOwnCapture).length;

  // Same predates-the-flag write-back as SETUP, and it matters most for the
  // signed-in-on-a-new-browser case: the rows are all remote, localStorage is
  // empty, and without this the user is walked through onboarding on top of a
  // library they already filled.
  let firstCaptureDone = localStorage.getItem(FIRST_CAPTURE) === "1";
  if (!firstCaptureDone && ownCaptures > 0) {
    firstCaptureDone = true;
    localStorage.setItem(FIRST_CAPTURE, "1");
  }

  const stage = onboardingStage({ setup, firstCaptureDone, ownCaptures, libraryNotEmpty });

  return {
    threads,
    screenshots,
    corrections,
    revisits,
    messages,
    stage,
    // Kept as its own field rather than inlined at the call site: shell.tsx
    // documents what it means, and "is the picker showing" is a different
    // question from "where in first run is this person".
    needsSetup: stage === "pick_role",
  };
}

/** Latch onboarding closed. Called once, on the first capture the user makes. */
export function completeFirstCapture() {
  localStorage.setItem(FIRST_CAPTURE, "1");
}

/** "Skip for now" from the role picker — a deliberate blank start. */
export async function skipSetup() {
  localStorage.setItem(SETUP, "empty");
  return loadAll();
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
  const b = await backend();
  // Sequential rather than Promise.all: threads must exist before screenshots
  // reference them, or the FK on project_thread_id rejects the write.
  for (const t of seededThreads()) await b.put("threads", t);
  for (const s of seededScreenshots()) await b.put("screenshots", s);

  localStorage.setItem(SETUP, "samples");
  return loadAll();
}

export async function resetAll() {
  const b = await backend();
  localStorage.removeItem(SETUP);
  // Both flags, or a reset library would keep claiming onboarding was finished.
  localStorage.removeItem(FIRST_CAPTURE);

  // Children before parents: corrections, revisits and messages all reference
  // a screenshot or thread, and deleting the parent first would be rejected by
  // the FK on the remote backend.
  for (const c of ["corrections", "revisits", "messages", "screenshots", "threads"] as const) {
    await b.clear(c);
  }
  await b.clearImages();

  return loadAll();
}

/**
 * "Use my own screenshots" — drops the first-run fixtures and keeps everything
 * real. A seeded project survives if real captures were filed into it; its chat
 * history goes with it if it does not.
 */
export async function clearSamples() {
  const b = await backend();
  const [screenshots, threads, messages] = await Promise.all([
    b.all<Screenshot>("screenshots"),
    b.all<Thread>("threads"),
    b.all<Message>("messages"),
  ]);

  for (const s of screenshots.filter((s) => s.source === "seed")) await deleteScreenshot(s);

  const seedIds = new Set(seededThreads().map((t) => t.id));
  const inUse = new Set(
    screenshots.filter((s) => s.source !== "seed").map((s) => s.threadId),
  );
  const dropped = threads.filter((t) => seedIds.has(t.id) && !inUse.has(t.id));

  for (const m of messages.filter((m) => dropped.some((t) => t.id === m.threadId))) {
    await b.del("messages", m.id);
  }
  for (const t of dropped) await b.del("threads", t.id);

  localStorage.setItem(SETUP, "empty");
  return loadAll();
}

/**
 * Write a capture. Pixels and row are persisted separately — locally the
 * full-size original moves to its own object store so `loadAll` does not pull
 * every base64 original into React state; remotely the bytes go to Storage and
 * the row keeps only their paths. Callers keep passing whole `Screenshot`
 * objects; the split is this function's business, not theirs.
 */
export async function putScreenshot(s: Screenshot) {
  const b = await backend();
  const paths = await b.saveImages(s);
  const stored: Screenshot = { ...s, ...paths };

  await b.put("screenshots", {
    ...stored,
    // Locally the original was just moved out; leaving it on the row would
    // store it twice. Only rows that also have a thumb are split — one without
    // has nothing else to render in the grid.
    imageDataUrl: b.kind === "local" && splitsOriginal(s) ? null : stored.imageDataUrl,
  });

  // Returned with the image still attached: the caller just handed it to us and
  // is about to render it, so making them re-read it would be silly. The paths
  // ride along so the detail view can fetch the original without a reload.
  return stored;
}

/**
 * Merge fields onto a capture as it exists *now*, rather than overwriting it
 * with a snapshot taken earlier.
 *
 * Classification takes up to a minute, and the write that followed it used to be
 * a whole-object `put` built from the pre-classify state — so filing, tagging,
 * archiving or editing the capture while the model was still looking at it was
 * silently undone. Reading immediately before writing keeps the window small
 * enough not to matter in a single-user app.
 */
export async function patchScreenshot(
  id: string,
  patch: Partial<Screenshot> | ((current: Screenshot) => Partial<Screenshot>),
): Promise<Screenshot | null> {
  const b = await backend();
  const raw = await b.get<Screenshot>("screenshots", id);
  if (!raw) return null;
  const current = withScreenshotDefaults(raw);
  // The functional form exists so a caller can decide *based on the current
  // row* — the model should fill `why_saved` and `intent`, but not overwrite
  // them if the user got there first.
  const fields = typeof patch === "function" ? patch(current) : patch;
  return putScreenshot({ ...current, ...fields });
}

/**
 * The full-size original, on demand. Only the detail view (hero, zoom, copy,
 * download) and re-classification need it; everything else renders `thumbDataUrl`.
 */
export async function getImage(id: string): Promise<string | null> {
  const b = await backend();
  const s = await b.get<Screenshot>("screenshots", id);
  return s ? b.loadImage(withScreenshotDefaults(s)) : null;
}

export async function putThread(t: Thread) {
  const b = await backend();
  await b.put("threads", t);
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
  const b = await backend();
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

  await b.put("screenshots", next);
  await b.put("corrections", correction);

  // Returned so the caller can refresh it in memory — the library orders project
  // shelves by recency, and a drop that did not visibly move its shelf reads as
  // if nothing happened.
  let thread: Thread | undefined;
  if (threadId) {
    const t = await b.get<Thread>("threads", threadId);
    if (t) {
      thread = withDescription({ ...t, lastActiveAt: new Date().toISOString() });
      await b.put("threads", thread);
    }
  }

  return { screenshot: next, correction, thread };
}

/** Editing why_saved is a training signal too — owner decision, overrides 06 §5. */
export async function editWhySaved(s: Screenshot, whySaved: string) {
  const b = await backend();
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
  await b.put("screenshots", next);
  await b.put("corrections", correction);
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
  await (await backend()).put("screenshots", next);
  return { screenshot: next };
}

/**
 * Remove a tag from either list. Dropping an AI tag is a rejection and writes a
 * correction so /memory can show it back and the few-shot window can learn from
 * it; dropping one of your own is just an edit.
 */
export async function removeTag(s: Screenshot, tag: string) {
  const b = await backend();
  const wasAi = s.tags.includes(tag);
  const next: Screenshot = {
    ...s,
    tags: s.tags.filter((t) => t !== tag),
    userTags: s.userTags.filter((t) => t !== tag),
  };

  if (!wasAi) {
    await b.put("screenshots", next);
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
  await b.put("screenshots", next);
  await b.put("corrections", correction);
  return { screenshot: next, correction };
}

export async function setIntent(s: Screenshot, intent: Screenshot["intent"]) {
  const b = await backend();
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
  await b.put("screenshots", next);
  await b.put("corrections", correction);
  return { screenshot: next, correction };
}

/** Hard delete, per F10 — image, rows and derived data all go. */
export async function deleteScreenshot(s: Screenshot) {
  const b = await backend();

  if (b.deleteCapture) {
    await b.deleteCapture(s);
    return;
  }

  // Pixels first: a Storage object whose row is already gone is unreachable, and
  // nothing would ever come back to clean it up.
  await b.removeImages(s);
  await b.del("screenshots", s.id);

  // Remotely, `user_corrections` and `revisit_events` are `on delete cascade`
  // against `screenshots` (migration 0001) — the row above took them with it.
  // IndexedDB has no foreign keys, so it needs the sweep done by hand.
  if (b.kind === "local") {
    const [corrections, revisits] = await Promise.all([
      b.all<Correction>("corrections"),
      b.all<Revisit>("revisits"),
    ]);
    await Promise.all([
      ...corrections.filter((c) => c.screenshotId === s.id).map((c) => b.del("corrections", c.id)),
      ...revisits.filter((r) => r.screenshotId === s.id).map((r) => b.del("revisits", r.id)),
    ]);
  }
}

export async function recordRevisit(screenshotId: string, kind: Revisit["kind"]) {
  const r: Revisit = { id: uid(), screenshotId, kind, createdAt: new Date().toISOString() };
  await (await backend()).put("revisits", r);
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
  await (await backend()).put("screenshots", next);
  return next;
}

/** "Forget this" — removing a correction removes it from the few-shot window. */
export async function forgetCorrection(id: string) {
  await (await backend()).del("corrections", id);
}

export async function addMessage(m: Omit<Message, "id" | "createdAt">): Promise<Message> {
  const msg: Message = { ...m, id: uid(), createdAt: new Date().toISOString() };
  await (await backend()).put("messages", msg);
  return msg;
}
