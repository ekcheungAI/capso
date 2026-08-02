import assert from "node:assert/strict";
import test from "node:test";
import { importLocalLibrary, remapIds, type ImportSource } from "./import-local.ts";
import { shot } from "../check-fixtures.ts";
import type { Correction, Message, Revisit, Thread } from "./types.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const thread = (id: string, name = "P"): Thread => ({
  id, name, description: "", createdAt: "2026-01-01T00:00:00Z",
  lastActiveAt: "2026-01-01T00:00:00Z", archived: false,
});

const empty = { threads: [], screenshots: [], corrections: [], revisits: [], messages: [] };

test("legacy ids become uuids", () => {
  const out = remapIds({ ...empty, threads: [thread("pricing-redesign")], screenshots: [shot({ id: "s1" })] });
  assert.match(out.threads[0]!.id, UUID);
  assert.match(out.screenshots[0]!.id, UUID);
});

test("ids that are already uuids are left alone", () => {
  const id = "3f2a1b4c-1111-4222-8333-444455556666";
  const out = remapIds({ ...empty, screenshots: [shot({ id })] });
  assert.equal(out.screenshots[0]!.id, id);
});

test("remapping is deterministic, so a re-run upserts instead of duplicating", () => {
  const a = remapIds({ ...empty, screenshots: [shot({ id: "s1" })] });
  const b = remapIds({ ...empty, screenshots: [shot({ id: "s1" })] });
  assert.equal(a.screenshots[0]!.id, b.screenshots[0]!.id);
});

test("a screenshot still points at its thread after both are remapped", () => {
  const out = remapIds({
    ...empty,
    threads: [thread("pricing-redesign")],
    screenshots: [shot({ id: "s1", threadId: "pricing-redesign", suggestedThreadId: "pricing-redesign" })],
  });
  assert.equal(out.screenshots[0]!.threadId, out.threads[0]!.id);
  assert.equal(out.screenshots[0]!.suggestedThreadId, out.threads[0]!.id);
});

test("an unfiled capture stays unfiled rather than being pointed at a fabricated thread", () => {
  const out = remapIds({ ...empty, screenshots: [shot({ id: "s1", threadId: null, suggestedThreadId: null })] });
  assert.equal(out.screenshots[0]!.threadId, null);
  assert.equal(out.screenshots[0]!.suggestedThreadId, null);
});

test("corrections and revisits follow their screenshot", () => {
  const corrections: Correction[] = [{
    id: "c1", screenshotId: "s1", field: "project", aiValue: null,
    userValue: "x", wasAiAccepted: false, createdAt: "2026-01-01T00:00:00Z",
  }];
  const revisits: Revisit[] = [{
    id: "r1", screenshotId: "s1", kind: "opened_detail", createdAt: "2026-01-01T00:00:00Z",
  }];
  const out = remapIds({ ...empty, screenshots: [shot({ id: "s1" })], corrections, revisits });
  const sid = out.screenshots[0]!.id;
  assert.equal(out.corrections[0]!.screenshotId, sid);
  assert.equal(out.revisits[0]!.screenshotId, sid);
  assert.match(out.corrections[0]!.id, UUID);
  assert.match(out.revisits[0]!.id, UUID);
});

test("chat messages keep both their thread and every capture they cited", () => {
  const messages: Message[] = [{
    id: "m1", threadId: "pricing-redesign", role: "assistant",
    text: "see [s1] and [s2]", citedIds: ["s1", "s2"], createdAt: "2026-01-01T00:00:00Z",
  }];
  const out = remapIds({
    ...empty,
    threads: [thread("pricing-redesign")],
    screenshots: [shot({ id: "s1" }), shot({ id: "s2" })],
    messages,
  });
  assert.equal(out.messages[0]!.threadId, out.threads[0]!.id);
  assert.deepEqual(out.messages[0]!.citedIds, out.screenshots.map((s) => s.id));
});

test("a citation to a capture that no longer exists is dropped, not carried as a dangling id", () => {
  // The row it pointed at was deleted locally. Carrying the old id across would
  // leave a citation chip that resolves to nothing.
  const messages: Message[] = [{
    id: "m1", threadId: "p", role: "assistant",
    text: "see [gone]", citedIds: ["gone"], createdAt: "2026-01-01T00:00:00Z",
  }];
  const out = remapIds({ ...empty, threads: [thread("p")], messages });
  assert.deepEqual(out.messages[0]!.citedIds, []);
});

test("a message whose project is gone is dropped, since its foreign key cannot be satisfied", () => {
  const messages: Message[] = [{
    id: "m1", threadId: "deleted-project", role: "user",
    text: "hi", citedIds: [], createdAt: "2026-01-01T00:00:00Z",
  }];
  assert.deepEqual(remapIds({ ...empty, messages }).messages, []);
});

test("a capture whose project is gone comes across unfiled rather than pointing at nothing", () => {
  const out = remapIds({ ...empty, screenshots: [shot({ id: "s1", threadId: "deleted-project" })] });
  assert.equal(out.screenshots[0]!.threadId, null);
});

test("a correction about a capture that no longer exists is dropped", () => {
  const corrections: Correction[] = [{
    id: "c1", screenshotId: "gone", field: "intent", aiValue: null,
    userValue: "other", wasAiAccepted: false, createdAt: "2026-01-01T00:00:00Z",
  }];
  assert.deepEqual(remapIds({ ...empty, corrections }).corrections, []);
});

// ------------------------------------------------------- orchestration ----

/** A stand-in library, so the ordering rules can be checked without a database. */
function fakeSource(over: Partial<Record<string, unknown[]>> = {}): ImportSource {
  const data: Record<string, unknown[]> = {
    threads: [thread("p")],
    screenshots: [shot({ id: "s1", threadId: "p", title: "One" })],
    corrections: [], revisits: [], messages: [], ...over,
  };
  return {
    all: async <T,>(c: string) => (data[c] ?? []) as T[],
    loadImage: async () => "data:image/png;base64,AAAA",
  };
}

function recorder() {
  const writes: string[] = [];
  return {
    writes,
    target: {
      put: async (c: string, v: { id: string }) => { writes.push(`${c}:${v.id.slice(0, 8)}`); },
      saveImages: async () => ({ originalPath: "u/o.png", thumbPath: "u/t.webp" }),
    },
  };
}

test("threads are written before the captures that reference them", async () => {
  const { writes, target } = recorder();
  await importLocalLibrary(target, undefined, fakeSource());
  const firstThread = writes.findIndex((w) => w.startsWith("threads:"));
  const firstShot = writes.findIndex((w) => w.startsWith("screenshots:"));
  assert.ok(firstThread >= 0 && firstShot > firstThread, `bad order: ${writes.join(", ")}`);
});

test("derived rows are written after the captures they hang off", async () => {
  const corrections: Correction[] = [{
    id: "c1", screenshotId: "s1", field: "intent", aiValue: null,
    userValue: "other", wasAiAccepted: false, createdAt: "2026-01-01T00:00:00Z",
  }];
  const { writes, target } = recorder();
  await importLocalLibrary(target, undefined, fakeSource({ corrections }));
  assert.ok(
    writes.findIndex((w) => w.startsWith("corrections:")) >
      writes.findIndex((w) => w.startsWith("screenshots:")),
    `bad order: ${writes.join(", ")}`,
  );
});

test("a capture whose pixels cannot be read is reported, and the rest still land", async () => {
  const source: ImportSource = {
    ...fakeSource({
      screenshots: [shot({ id: "s1", threadId: "p", title: "Broken" }), shot({ id: "s2", threadId: "p", title: "Fine" })],
    }),
    loadImage: async (s) => { if (s.id === "s1") throw new Error("unreadable"); return "data:image/png;base64,AAAA"; },
  };
  const { writes, target } = recorder();
  const res = await importLocalLibrary(target, undefined, source);
  assert.deepEqual(res.failed, ["Broken"]);
  assert.equal(res.captures, 1);
  assert.equal(writes.filter((w) => w.startsWith("screenshots:")).length, 1);
});

test("progress is reported and reaches its own total", async () => {
  const seen: number[] = [];
  let total = 0;
  await importLocalLibrary(recorder().target, (p) => { seen.push(p.done); total = p.total; }, fakeSource());
  assert.equal(seen[seen.length - 1], total);
  assert.deepEqual(seen, [1, 2]); // one project, one capture
});

test("two different legacy ids never collide", () => {
  const ids = ["s1", "s2", "s10", "pricing-redesign", "capso-bugs", "msae96uvjzk"];
  const out = remapIds({ ...empty, screenshots: ids.map((id) => shot({ id })) });
  assert.equal(new Set(out.screenshots.map((s) => s.id)).size, ids.length);
});
