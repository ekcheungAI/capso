/**
 * Minimal IndexedDB wrapper — no dependency needed for five object stores.
 * Demo persistence only; P1 replaces this file with Supabase calls behind the
 * same async surface in ./index.ts.
 */

const DB_NAME = "capso";
/** v3 split full-size originals out of `screenshots` into `images`. */
const DB_VERSION = 3;

export const STORES = [
  "screenshots",
  "threads",
  "corrections",
  "revisits",
  "messages",
  /**
   * Full-size originals, one row per capture, keyed by screenshot id.
   *
   * They used to live on the screenshot row itself, which meant `loadAll` —
   * which reads every row on mount — pulled every base64 original into React
   * state. At a few hundred KB a capture that is hundreds of megabytes resident
   * before the DOM decodes anything. The row now carries only the 800px thumb;
   * the original is fetched on demand by the two surfaces that need it.
   */
  "images",
] as const;
export type StoreName = (typeof STORES)[number];

export type StoredImage = { id: string; dataUrl: string };

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
      }

      /**
       * v2 → v3: move originals off the rows that already exist. Done inside the
       * versionchange transaction so a library captured before this release is
       * migrated exactly once, rather than half-migrating on first write and
       * leaving the rest of the collection heavy forever.
       */
      if (event.oldVersion > 0 && event.oldVersion < 3 && req.transaction) {
        const shots = req.transaction.objectStore("screenshots");
        const images = req.transaction.objectStore("images");
        shots.openCursor().onsuccess = (e) => {
          const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
          if (!cursor) return;
          const row = cursor.value as {
            id: string;
            imageDataUrl?: string | null;
            thumbDataUrl?: string | null;
          };
          // Only rows that already have a thumb can give up their original — a
          // capture taken before thumbs existed has nothing else to render in
          // the grid, so moving its image out would blank it. Those keep the
          // original inline and age out naturally.
          if (row.imageDataUrl && row.thumbDataUrl) {
            images.put({ id: row.id, dataUrl: row.imageDataUrl });
            cursor.update({ ...row, imageDataUrl: null });
          }
          cursor.continue();
        };
      }
    };
    req.onsuccess = () => {
      // Another tab bumping the version later would otherwise leave this
      // connection live and block it indefinitely.
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
    /**
     * A version upgrade cannot proceed while another tab holds an older
     * connection. Without this handler the promise simply never settles, and
     * every caller — including the one that decides whether the app is `ready`
     * — waits forever behind a skeleton with nothing to explain it.
     */
    req.onblocked = () =>
      reject(
        new Error(
          "Capso is open in another tab running an older version. Close it and reload.",
        ),
      );
  });

  // A failed open must not be cached, or the app can never recover without a
  // full reload — the user closing the other tab should be enough.
  dbPromise.catch(() => {
    dbPromise = null;
  });

  return dbPromise;
}

function run<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const idb = {
  all: <T>(store: StoreName) => run<T[]>(store, "readonly", (s) => s.getAll()),
  get: <T>(store: StoreName, id: string) => run<T | undefined>(store, "readonly", (s) => s.get(id)),
  put: <T extends { id: string }>(store: StoreName, value: T) =>
    run<IDBValidKey>(store, "readwrite", (s) => s.put(value)),
  del: (store: StoreName, id: string) => run<undefined>(store, "readwrite", (s) => s.delete(id)),
  clear: (store: StoreName) => run<undefined>(store, "readwrite", (s) => s.clear()),
};
