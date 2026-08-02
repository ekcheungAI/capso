// Extensionful so `import-local.check.ts` can exercise `remapIds` under plain
// node — the same convention retrieve.ts documents at its head.
import { localBackend, type Collection } from "./backend.ts";
import { uuidFromSeed } from "./map.ts";
import type { Correction, Message, Revisit, Screenshot, Thread } from "./types.ts";

/**
 * Move a library that was captured into this browser up to Supabase.
 *
 * Without this, switching a browser from the local backend to the remote one
 * silently empties the library: nothing is deleted, but every capture taken
 * before the switch becomes invisible, which is indistinguishable from data loss
 * to the person it happens to.
 *
 * The whole problem is ids. Local rows carry whatever `uid()` produced at the
 * time — `"s1"` for a fixture, `"msae96uvjzk"` for a capture taken before ids
 * became uuids — and Postgres `uuid` columns reject all of them. Rewriting an id
 * means rewriting every reference to it, and there are six: a capture's thread
 * and suggested thread, a correction's and a revisit's screenshot, a message's
 * thread, and every id a message cited.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isUuid = (id: string) => UUID_RE.test(id);

/**
 * Derived, never random. A random id would make a second import a second copy of
 * the whole library; a derived one upserts the same rows, so a run interrupted
 * halfway can simply be run again.
 */
const mapId = (id: string) => (isUuid(id) ? id : uuidFromSeed(id));

export type Library = {
  threads: Thread[];
  screenshots: Screenshot[];
  corrections: Correction[];
  revisits: Revisit[];
  messages: Message[];
};

/**
 * Rewrite every id and every reference to one, as a pure function so the
 * referential integrity of the result can be tested without touching a database.
 *
 * Rows that reference something absent are dropped or unfiled rather than
 * carried across pointing at nothing: a correction about a deleted capture would
 * violate its foreign key, and a citation to one would render a chip that
 * resolves to nothing.
 */
export function remapIds(lib: Library): Library {
  const threads = new Map(lib.threads.map((t) => [t.id, mapId(t.id)]));
  const shots = new Map(lib.screenshots.map((s) => [s.id, mapId(s.id)]));

  // A capture whose project no longer exists comes across unfiled — it lands in
  // the Inbox, which is exactly where an unrouted capture belongs.
  const thread = (id: string | null) => (id === null ? null : (threads.get(id) ?? null));

  return {
    threads: lib.threads.map((t) => ({ ...t, id: threads.get(t.id)! })),

    screenshots: lib.screenshots.map((s) => ({
      ...s,
      id: shots.get(s.id)!,
      threadId: thread(s.threadId),
      suggestedThreadId: thread(s.suggestedThreadId),
    })),

    corrections: lib.corrections
      .filter((c) => shots.has(c.screenshotId))
      .map((c) => ({ ...c, id: mapId(c.id), screenshotId: shots.get(c.screenshotId)! })),

    revisits: lib.revisits
      .filter((r) => shots.has(r.screenshotId))
      .map((r) => ({ ...r, id: mapId(r.id), screenshotId: shots.get(r.screenshotId)! })),

    messages: lib.messages
      .filter((m) => threads.has(m.threadId))
      .map((m) => ({
        ...m,
        id: mapId(m.id),
        threadId: threads.get(m.threadId)!,
        citedIds: m.citedIds
          .map((id) => shots.get(id))
          .filter((id): id is string => Boolean(id)),
      })),
  };
}

/** What is sitting in this browser waiting to be moved. */
export async function localLibrarySize(): Promise<number> {
  const shots = await localBackend.all<Screenshot>("screenshots");
  return shots.length;
}

export type ImportProgress = { done: number; total: number };
export type ImportResult = { captures: number; threads: number; failed: string[] };

/**
 * Read the local library, rewrite its ids, and write it through `target`.
 *
 * Order is dictated by foreign keys: threads exist before the captures that
 * reference them, and captures before the corrections, revisits and messages
 * that reference *them*. Getting this wrong does not corrupt anything — the
 * write is simply rejected — but it does strand half a library.
 *
 * Images are re-read from local storage one at a time rather than held in memory
 * together: originals are megabytes each, and `loadAll` was moved off carrying
 * them for exactly that reason.
 */
export type ImportTarget = {
  put: (c: Collection, v: { id: string }) => Promise<void>;
  saveImages: (s: Screenshot) => Promise<Pick<Screenshot, "originalPath" | "thumbPath">>;
};

/** Only the two operations the import reads from. Injectable so it can be tested. */
export type ImportSource = {
  all: <T>(c: Collection) => Promise<T[]>;
  loadImage: (s: Screenshot) => Promise<string | null>;
};

export async function importLocalLibrary(
  target: ImportTarget,
  onProgress?: (p: ImportProgress) => void,
  source: ImportSource = localBackend,
): Promise<ImportResult> {
  const [threads, screenshots, corrections, revisits, messages] = await Promise.all([
    source.all<Thread>("threads"),
    source.all<Screenshot>("screenshots"),
    source.all<Correction>("corrections"),
    source.all<Revisit>("revisits"),
    source.all<Message>("messages"),
  ]);

  const lib = remapIds({ threads, screenshots, corrections, revisits, messages });
  const failed: string[] = [];
  const total = lib.threads.length + lib.screenshots.length;
  let done = 0;
  const tick = () => onProgress?.({ done: ++done, total });

  for (const t of lib.threads) {
    try {
      await target.put("threads", t);
    } catch {
      failed.push(`project “${t.name}”`);
    }
    tick();
  }

  // `remapIds` preserves order, so index i in the rewritten list is the same
  // capture as index i in the original — which is how the pixels, still filed
  // under the *old* id, are found for a row that now carries a new one.
  for (const [i, s] of lib.screenshots.entries()) {
    try {
      const local = screenshots[i]!;
      const imageDataUrl = local.imageDataUrl ?? (await source.loadImage(local));
      const withPixels: Screenshot = { ...s, imageDataUrl, thumbDataUrl: local.thumbDataUrl };
      const paths = await target.saveImages(withPixels);
      await target.put("screenshots", { ...withPixels, ...paths });
    } catch {
      failed.push(s.title || "an untitled capture");
    }
    tick();
  }

  // Derived data last, and quietly: a lost correction costs a little learning,
  // never a capture, so one failing must not abort the captures still to come.
  for (const c of lib.corrections) await target.put("corrections", c).catch(() => {});
  for (const r of lib.revisits) await target.put("revisits", r).catch(() => {});
  for (const m of lib.messages) await target.put("messages", m).catch(() => {});

  return { captures: lib.screenshots.length - failed.length, threads: lib.threads.length, failed };
}
