import assert from "node:assert/strict";
import test from "node:test";
import { deleteOwnedScreenshot, type DeleteScreenshotPort } from "./delete-screenshot.ts";
import {
  ownedScreenshotObjectPath,
  storageObjectPath,
  storedStoragePath,
} from "../store/storage-path.ts";

const USER = "00000000-0000-4000-8000-000000000001";
const SHOT = "11111111-1111-4111-8111-111111111111";

test("storage paths bridge canonical native rows and legacy web rows", () => {
  assert.equal(storageObjectPath("originals", `originals/${USER}/${SHOT}.png`), `${USER}/${SHOT}.png`);
  assert.equal(storageObjectPath("thumbs", `${USER}/${SHOT}.webp`), `${USER}/${SHOT}.webp`);
  assert.equal(storedStoragePath("thumbs", `${USER}/${SHOT}.webp`), `thumbs/${USER}/${SHOT}.webp`);
});

test("owned screenshot paths cannot escape the verified owner or capture", () => {
  assert.equal(
    ownedScreenshotObjectPath("originals", `originals/${USER}/${SHOT}.png`, USER, SHOT),
    `${USER}/${SHOT}.png`,
  );
  assert.throws(() =>
    ownedScreenshotObjectPath(
      "originals",
      "originals/22222222-2222-4222-8222-222222222222/11111111-1111-4111-8111-111111111111.png",
      USER,
      SHOT,
    )
  );
  assert.throws(() =>
    ownedScreenshotObjectPath("originals", `originals/${USER}/other.png`, USER, SHOT)
  );
});

test("server-owned deletion validates both paths, removes pixels, then removes the row", async () => {
  const calls: string[] = [];
  const port: DeleteScreenshotPort = {
    async read(id, userId) {
      calls.push(`read:${userId}:${id}`);
      return {
        storagePath: `originals/${USER}/${SHOT}.png`,
        thumbPath: `thumbs/${USER}/${SHOT}.webp`,
      };
    },
    async remove(bucket, path) {
      calls.push(`remove:${bucket}:${path}`);
    },
    async removeRow(id, userId) {
      calls.push(`row:${userId}:${id}`);
    },
  };

  assert.equal(await deleteOwnedScreenshot(SHOT, USER, port), "deleted");
  assert.deepEqual(calls, [
    `read:${USER}:${SHOT}`,
    `remove:originals:${USER}/${SHOT}.png`,
    `remove:thumbs:${USER}/${SHOT}.webp`,
    `row:${USER}:${SHOT}`,
  ]);
});

test("an invalid database path fails before any object or row is deleted", async () => {
  const mutations: string[] = [];
  const port: DeleteScreenshotPort = {
    async read() {
      return { storagePath: `originals/${USER}/${SHOT}.png`, thumbPath: `thumbs/${USER}/other.png` };
    },
    async remove() { mutations.push("object"); },
    async removeRow() { mutations.push("row"); },
  };

  await assert.rejects(deleteOwnedScreenshot(SHOT, USER, port));
  assert.deepEqual(mutations, []);
});
