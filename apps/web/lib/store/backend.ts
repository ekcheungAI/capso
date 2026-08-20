import { idb } from "./db.ts";
import type { Screenshot } from "./types.ts";

/**
 * Which store the data layer is talking to.
 *
 * `index.ts` holds all the *rules* — when a correction is written, which tag list
 * a tag lands in, how confidence routes a capture. Those must not be duplicated
 * per backend, so everything they need is expressed as the small set of
 * primitives below and implemented twice: once against IndexedDB, once against
 * Supabase.
 *
 * The primitive set is deliberately the same shape `idb` already exposed, plus
 * four image operations — the one place the two backends genuinely differ, since
 * local keeps base64 on the row and remote keeps bytes in Storage.
 */

/** Logical collections. `remote.ts` maps these to their Postgres tables. */
export type Collection = "screenshots" | "threads" | "corrections" | "revisits" | "messages";

export type Backend = {
  kind: "local" | "remote";

  all<T>(c: Collection): Promise<T[]>;
  get<T>(c: Collection, id: string): Promise<T | undefined>;
  put<T extends { id: string }>(c: Collection, value: T): Promise<void>;
  del(c: Collection, id: string): Promise<void>;
  clear(c: Collection): Promise<void>;

  /**
   * Persist a capture's pixels and report where they went. Local returns nulls —
   * its bytes live on the row — so `originalPath`/`thumbPath` stay null exactly
   * as they always have been for IndexedDB libraries.
   */
  saveImages(s: Screenshot): Promise<Pick<Screenshot, "originalPath" | "thumbPath">>;
  /** The full-size original, on demand: a data URL locally, a signed URL remotely. */
  loadImage(s: Screenshot): Promise<string | null>;
  /**
   * Give a freshly-read set of rows something the grid can render. Local rows
   * already carry their thumb inline, so this is identity; remote rows carry a
   * path and need it signed — in one batched call, not one per capture.
   */
  hydrateThumbs(rows: Screenshot[]): Promise<Screenshot[]>;
  removeImages(s: Screenshot): Promise<void>;
  /** Coordinate a full remote delete behind one authenticated server boundary. */
  deleteCapture?(s: Screenshot): Promise<void>;
  /** Drop every image this user owns — `resetAll` only. */
  clearImages(): Promise<void>;
};

// ---------------------------------------------------------------- local ----

const local: Backend = {
  kind: "local",

  all: (c) => idb.all(c),
  get: (c, id) => idb.get(c, id),
  async put(c, value) {
    await idb.put(c, value);
  },
  async del(c, id) {
    await idb.del(c, id);
  },
  async clear(c) {
    await idb.clear(c);
  },

  /**
   * Split the original out of the row. It used to live on the row itself, which
   * meant `loadAll` pulled every base64 original into React state on mount; the
   * row now carries only the thumb (see db.ts STORES.images).
   *
   * Only split when a thumb exists to render in the original's place — a capture
   * taken before thumbs existed would otherwise have nothing to show in the grid.
   */
  async saveImages(s) {
    if (s.imageDataUrl && s.thumbDataUrl) {
      await idb.put("images", { id: s.id, dataUrl: s.imageDataUrl });
    }
    return { originalPath: null, thumbPath: null };
  },
  async loadImage(s) {
    const row = await idb.get<{ id: string; dataUrl: string }>("images", s.id);
    return row?.dataUrl ?? null;
  },
  hydrateThumbs: async (rows) => rows,
  async removeImages(s) {
    await idb.del("images", s.id);
  },
  async clearImages() {
    await idb.clear("images");
  },
};

/** Whether a local row should keep its image inline after `saveImages`. */
export const splitsOriginal = (s: Screenshot) => Boolean(s.imageDataUrl && s.thumbDataUrl);

// ------------------------------------------------------------- selection ----

export type BackendPreference = "auto" | "local";

let preference: BackendPreference = "auto";
let chosen: Promise<Backend> | null = null;
const PREFERENCE_KEY = "capso.backend-preference";
const preferenceListeners = new Set<() => void>();

export function validBackendPreference(value: string | null): BackendPreference {
  return value === "local" ? "local" : "auto";
}

/**
 * Pick a backend once, then keep it for the life of the tab.
 *
 * An unconfigured developer build remains local-first. A configured build never
 * silently falls back: auth/network/schema failures must be visible, otherwise a
 * person can believe their synced library was wiped while viewing IndexedDB.
 */
export function backend(): Promise<Backend> {
  chosen ??= (async (): Promise<Backend> => {
    if (backendPreference() === "local") return local;

    const { isConfigured } = await import("@/lib/supabase/client");
    if (!isConfigured()) return local;

    const { remote } = await import("./remote");
    return remote();
  })();

  return chosen;
}

/** Deliberate account-entry choice. Changing it invalidates the per-tab cache. */
export function setBackendPreference(next: BackendPreference) {
  preference = next;
  if (typeof window !== "undefined") {
    if (next === "local") window.localStorage.setItem(PREFERENCE_KEY, next);
    else window.localStorage.removeItem(PREFERENCE_KEY);
  }
  chosen = null;
  for (const listener of preferenceListeners) listener();
}

export function backendPreference(): BackendPreference {
  if (typeof window === "undefined") return preference;
  return validBackendPreference(window.localStorage.getItem(PREFERENCE_KEY));
}

export function subscribeBackendPreference(listener: () => void) {
  preferenceListeners.add(listener);
  return () => preferenceListeners.delete(listener);
}

/** Test seam: forget the cached choice. */
export function resetBackend() {
  chosen = null;
}

export { local as localBackend };
