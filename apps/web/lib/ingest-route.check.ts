import assert from "node:assert/strict";
import test from "node:test";
import { GET, POST } from "../app/api/ingest/route.ts";

const APP = "http://localhost:3000";
const EXTENSION = "chrome-extension://capso-test";
const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";

const request = (path: string, init?: RequestInit) => new Request(`${APP}${path}`, init);

test("extension delivery stays addressed, stable and acknowledged end to end", async () => {
  const id = `capture_${crypto.randomUUID()}`;
  const device = `device_${crypto.randomUUID()}`;
  const otherDevice = `device_${crypto.randomUUID()}`;

  const offered = await POST(
    request("/api/ingest", {
      method: "POST",
      headers: { origin: EXTENSION, "content-type": "application/json" },
      body: JSON.stringify({
        id,
        deviceToken: device,
        imageDataUrl: PIXEL,
        pageUrl: "https://example.com/reference",
        pageTitle: "Reference page",
      }),
    }),
  );
  assert.equal(offered.status, 200);

  const wrongDevice = await GET(
    request(`/api/ingest?device=${encodeURIComponent(otherDevice)}`, {
      headers: { "x-capso-poll": "1" },
    }),
  );
  assert.deepEqual((await wrongDevice.json()).items, []);

  const delivery = await GET(
    request(`/api/ingest?device=${encodeURIComponent(device)}`, {
      headers: { "x-capso-poll": "1" },
    }),
  );
  const delivered = (await delivery.json()) as { items: { id: string; pageTitle?: string }[] };
  assert.equal(delivered.items.length, 1);
  assert.equal(delivered.items[0]?.id, id);
  assert.equal(delivered.items[0]?.pageTitle, "Reference page");

  const acknowledged = await POST(
    request("/api/ingest", {
      method: "POST",
      headers: { origin: APP, "content-type": "application/json" },
      body: JSON.stringify({ ack: [id] }),
    }),
  );
  assert.equal(acknowledged.status, 200);

  const check = await POST(
    request("/api/ingest", {
      method: "POST",
      headers: { origin: EXTENSION, "content-type": "application/json" },
      body: JSON.stringify({ check: [id] }),
    }),
  );
  assert.deepEqual((await check.json()).confirmed, [id]);

  const retry = await POST(
    request("/api/ingest", {
      method: "POST",
      headers: { origin: EXTENSION, "content-type": "application/json" },
      body: JSON.stringify({ id, deviceToken: device, imageDataUrl: PIXEL }),
    }),
  );
  assert.deepEqual(await retry.json(), { status: "confirmed", duplicate: true });
});

test("the relay rejects unpaired and cross-site capture writes", async () => {
  const id = `capture_${crypto.randomUUID()}`;

  const unpaired = await POST(
    request("/api/ingest", {
      method: "POST",
      headers: { origin: EXTENSION, "content-type": "application/json" },
      body: JSON.stringify({ id, imageDataUrl: PIXEL }),
    }),
  );
  assert.equal(unpaired.status, 400);

  const forged = await POST(
    request("/api/ingest", {
      method: "POST",
      headers: { origin: "https://attacker.example", "content-type": "application/json" },
      body: JSON.stringify({ id, deviceToken: `device_${crypto.randomUUID()}`, imageDataUrl: PIXEL }),
    }),
  );
  assert.equal(forged.status, 403);
});
