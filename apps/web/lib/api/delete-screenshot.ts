import {
  ownedScreenshotObjectPath,
  type ScreenshotBucket,
} from "../store/storage-path.ts";

export type ScreenshotStorageRow = {
  storagePath: string | null;
  thumbPath: string | null;
};

export type DeleteScreenshotPort = {
  read(id: string, userId: string): Promise<ScreenshotStorageRow | null>;
  remove(bucket: ScreenshotBucket, objectPath: string): Promise<void>;
  removeRow(id: string, userId: string): Promise<void>;
};

export type DeleteScreenshotResult = "deleted" | "not_found";

/**
 * Delete pixels before the row, so a transient Storage failure leaves a fully
 * retryable capture rather than an invisible orphan. Paths are database-owned
 * and revalidated against the verified account and screenshot id before either
 * bucket is touched.
 */
export async function deleteOwnedScreenshot(
  id: string,
  userId: string,
  port: DeleteScreenshotPort,
): Promise<DeleteScreenshotResult> {
  const row = await port.read(id, userId);
  if (!row) return "not_found";

  const objects: Array<[ScreenshotBucket, string]> = [];
  if (row.storagePath) {
    objects.push([
      "originals",
      ownedScreenshotObjectPath("originals", row.storagePath, userId, id),
    ]);
  }
  if (row.thumbPath) {
    objects.push([
      "thumbs",
      ownedScreenshotObjectPath("thumbs", row.thumbPath, userId, id),
    ]);
  }

  await Promise.all(objects.map(([bucket, path]) => port.remove(bucket, path)));
  await port.removeRow(id, userId);
  return "deleted";
}
