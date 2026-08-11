export type ScreenshotBucket = "originals" | "thumbs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE_EXTENSION = /^(?:png|jpe?g|webp)$/i;

/**
 * Database rows keep the bucket prefix so one path is self-describing. The
 * Storage client already receives the bucket separately, so strip it there.
 * Legacy web rows omitted the prefix; accepting both keeps existing libraries
 * readable while all new writes converge on the canonical form.
 */
export function storageObjectPath(bucket: ScreenshotBucket, storedPath: string): string {
  const prefix = `${bucket}/`;
  return storedPath.startsWith(prefix) ? storedPath.slice(prefix.length) : storedPath;
}

export function storedStoragePath(bucket: ScreenshotBucket, objectPath: string): string {
  return `${bucket}/${storageObjectPath(bucket, objectPath)}`;
}

/** Refuse to turn a compromised row into authority to delete another object. */
export function ownedScreenshotObjectPath(
  bucket: ScreenshotBucket,
  storedPath: string,
  userId: string,
  screenshotId: string,
): string {
  const objectPath = storageObjectPath(bucket, storedPath);
  const parts = objectPath.split("/");
  const [owner, file] = parts;
  const [id, extension] = file?.split(".") ?? [];
  if (
    parts.length !== 2 ||
    !UUID.test(userId) ||
    !UUID.test(screenshotId) ||
    owner !== userId ||
    id !== screenshotId ||
    !extension ||
    !IMAGE_EXTENSION.test(extension)
  ) {
    throw new Error("invalid owned screenshot storage path");
  }
  return objectPath;
}
