import { accountFetch, requireSession, supabase } from "@/lib/supabase/client";
import type { Backend, Collection } from "./backend";
import {
  correctionFromRow, correctionToRow,
  fromRow, messageFromRow, messageToRow,
  revisitFromRow, revisitToRow,
  threadFromRow, threadToRow, toRow,
} from "./map";
import type { Correction, Message, Revisit, Screenshot, Thread } from "./types";
import { storageObjectPath, storedStoragePath } from "./storage-path";

/**
 * The Supabase half of the data layer. Every rule lives in `index.ts`; this file
 * only moves rows and bytes.
 *
 * All reads are implicitly scoped to the signed-in user by RLS
 * (`using (user_id = auth.uid())`, migration 0001), so no query here filters on
 * `user_id` for *safety* — only writes set it, because the column is not
 * defaulted server-side and a row written with the wrong owner is invisible to
 * its own author.
 */

const TABLE: Record<Collection, string> = {
  screenshots: "screenshots",
  threads: "project_threads",
  corrections: "user_corrections",
  revisits: "revisit_events",
  messages: "conversation_messages",
};

/** Detail pixels are brief; grid previews may live for one browsing session. */
const ORIGINAL_URL_TTL = 60;
const THUMB_URL_TTL = 10 * 60;

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** `data:image/webp;base64,...` → the mime type, defaulting to png. */
function mimeOf(dataUrl: string): string {
  return dataUrl.match(/^data:([^;,]+)/)?.[1] ?? "image/png";
}

/** Browsers decode `data:` URLs through fetch, so no manual base64 parsing. */
async function toBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return res.blob();
}

export async function remote(): Promise<Backend> {
  // A configured deployment must have a permanent email account. Opening a
  // local fallback here would make a signed-out library look mysteriously empty.
  const userId = await requireSession();
  const sb = supabase();

  /** Upload one image and return its object path, or null if there was nothing. */
  async function upload(
    bucket: "originals" | "thumbs",
    id: string,
    dataUrl: string | null,
  ): Promise<string | null> {
    if (!dataUrl) return null;
    const mime = mimeOf(dataUrl);
    const path = `${userId}/${id}.${EXT[mime] ?? "png"}`;
    const { error } = await sb.storage
      .from(bucket)
      .upload(path, await toBlob(dataUrl), { contentType: mime, upsert: true });
    if (error) throw error;
    return storedStoragePath(bucket, path);
  }

  /** Remove every object this user owns in a bucket — used by `resetAll`. */
  async function wipeBucket(bucket: "originals" | "thumbs") {
    const { data } = await sb.storage.from(bucket).list(userId);
    const paths = (data ?? []).map((f) => `${userId}/${f.name}`);
    if (paths.length) {
      const { error } = await sb.storage.from(bucket).remove(paths);
      if (error) throw error;
    }
  }

  return {
    kind: "remote",

    async all<T>(c: Collection): Promise<T[]> {
      const { data, error } = await sb.from(TABLE[c]).select("*");
      if (error) throw error;
      return (data ?? []).map((r) => decode(c, r)) as T[];
    },

    async get<T>(c: Collection, id: string): Promise<T | undefined> {
      // maybeSingle, not single: a missing row is an ordinary outcome here —
      // `patchScreenshot` relies on it to detect a capture deleted mid-classify.
      const { data, error } = await sb.from(TABLE[c]).select("*").eq("id", id).maybeSingle();
      if (error) throw error;
      return data ? (decode(c, data) as T) : undefined;
    },

    async put(c, value) {
      // `supabase-js` infers a row type from a *literal* table name; ours is
      // chosen at runtime, so it cannot. The cast buys nothing back that the
      // mappers do not already guarantee — `map.check.ts` is what actually
      // holds the row shapes to the schema.
      const row = encode(c, value, userId) as never;
      const { error } = await sb.from(TABLE[c]).upsert(row);
      if (error) throw error;
    },

    async del(c, id) {
      const { error } = await sb.from(TABLE[c]).delete().eq("id", id);
      if (error) throw error;
    },

    async clear(c) {
      // RLS already limits the scope to this user; the filter is required only
      // because PostgREST refuses an unbounded delete.
      const { error } = await sb.from(TABLE[c]).delete().eq("user_id", userId);
      if (error) throw error;
    },

    /**
     * Falls back to the paths the capture already has when there is nothing new
     * to upload. `patchScreenshot` re-writes a row it just read, and a read row
     * carries no data URLs — without this, every patch would null out the paths
     * to a perfectly good pair of objects and orphan them in Storage.
     */
    async saveImages(s) {
      const [original, thumb] = await Promise.all([
        upload("originals", s.id, s.imageDataUrl),
        upload("thumbs", s.id, s.thumbDataUrl),
      ]);
      return {
        originalPath: original ?? s.originalPath,
        thumbPath: thumb ?? s.thumbPath,
      };
    },

    async loadImage(s) {
      if (!s.originalPath) return null;
      const { data } = await sb.storage
        .from("originals")
        .createSignedUrl(storageObjectPath("originals", s.originalPath), ORIGINAL_URL_TTL);
      return data?.signedUrl ?? null;
    },

    /**
     * One batched signing call for the whole grid. Signing per row turned a
     * library open into one network round trip per capture.
     */
    async hydrateThumbs(rows) {
      const paths = rows
        .map((r) => r.thumbPath)
        .filter((p): p is string => Boolean(p))
        .map((stored) => storageObjectPath("thumbs", stored));
      if (!paths.length) return rows;

      const { data, error } = await sb.storage
        .from("thumbs")
        .createSignedUrls(paths, THUMB_URL_TTL);
      if (error) throw error;
      const byPath = new Map((data ?? []).map((d) => [d.path, d.signedUrl]));

      return rows.map((r) => {
        const objectPath = r.thumbPath ? storageObjectPath("thumbs", r.thumbPath) : null;
        return objectPath && byPath.get(objectPath)
          ? { ...r, thumbDataUrl: byPath.get(objectPath)! }
          : r;
      });
    },

    async removeImages(s) {
      const results = await Promise.all([
        s.originalPath
          ? sb.storage.from("originals").remove([storageObjectPath("originals", s.originalPath)])
          : null,
        s.thumbPath
          ? sb.storage.from("thumbs").remove([storageObjectPath("thumbs", s.thumbPath)])
          : null,
      ]);
      for (const result of results) {
        if (result?.error) throw result.error;
      }
    },

    async deleteCapture(s) {
      const response = await accountFetch(`/api/screenshots/${encodeURIComponent(s.id)}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("The capture could not be deleted.");
    },

    async clearImages() {
      await Promise.all([wipeBucket("originals"), wipeBucket("thumbs")]);
    },
  };
}

// ------------------------------------------------------------ conversion ----

/* eslint-disable @typescript-eslint/no-explicit-any -- the row shape is chosen
   by the collection at runtime; each branch is typed at its mapper. */

function decode(c: Collection, row: any) {
  switch (c) {
    case "screenshots": return fromRow(row);
    case "threads": return threadFromRow(row);
    case "corrections": return correctionFromRow(row);
    case "revisits": return revisitFromRow(row);
    case "messages": return messageFromRow(row);
  }
}

function encode(c: Collection, value: any, userId: string) {
  switch (c) {
    case "screenshots": return toRow(value as Screenshot, userId);
    case "threads": return threadToRow(value as Thread, userId);
    case "corrections": return correctionToRow(value as Correction, userId);
    case "revisits": return revisitToRow(value as Revisit, userId);
    case "messages": return messageToRow(value as Message, userId);
  }
}
