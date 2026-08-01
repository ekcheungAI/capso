/**
 * Minimal IndexedDB wrapper — no dependency needed for five object stores.
 * Demo persistence only; P1 replaces this file with Supabase calls behind the
 * same async surface in ./index.ts.
 */

const DB_NAME = "capso";
const DB_VERSION = 2;

export const STORES = ["screenshots", "threads", "corrections", "revisits", "messages"] as const;
export type StoreName = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
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
