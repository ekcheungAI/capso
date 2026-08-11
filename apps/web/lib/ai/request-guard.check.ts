import assert from "node:assert/strict";
import test from "node:test";
import {
  CLASSIFY_BODY_LIMIT,
  CHAT_BODY_LIMIT,
  contentLengthAllowed,
  parseChatInput,
  parseClassifyInput,
  readJsonBody,
} from "./request-guard.ts";

const tinyPng = `data:image/png;base64,${Buffer.from("pixels").toString("base64")}`;

test("request byte limits reject oversized bodies before JSON parsing", () => {
  assert.equal(contentLengthAllowed(String(CLASSIFY_BODY_LIMIT), CLASSIFY_BODY_LIMIT), true);
  assert.equal(contentLengthAllowed(String(CLASSIFY_BODY_LIMIT + 1), CLASSIFY_BODY_LIMIT), false);
  assert.equal(contentLengthAllowed(String(CHAT_BODY_LIMIT + 1), CHAT_BODY_LIMIT), false);
  assert.equal(contentLengthAllowed(null, CHAT_BODY_LIMIT), true);
  assert.equal(contentLengthAllowed("not-a-number", CHAT_BODY_LIMIT), false);
});

test("the actual streamed body is capped when content-length is absent or dishonest", async () => {
  const oversized = new Request("https://capso.example/api/chat", {
    method: "POST",
    body: JSON.stringify({ question: "x".repeat(CHAT_BODY_LIMIT + 1) }),
  });
  assert.equal(oversized.headers.get("content-length"), null);
  assert.deepEqual(await readJsonBody(oversized, CHAT_BODY_LIMIT), { ok: false, error: "too_large" });

  const dishonest = new Request("https://capso.example/api/chat", {
    method: "POST",
    headers: { "content-length": "2" },
    body: JSON.stringify({ question: "x".repeat(CHAT_BODY_LIMIT + 1) }),
  });
  assert.deepEqual(await readJsonBody(dishonest, CHAT_BODY_LIMIT), { ok: false, error: "too_large" });

  const valid = new Request("https://capso.example/api/chat", {
    method: "POST",
    body: JSON.stringify({ question: "What did I save?" }),
  });
  assert.deepEqual(await readJsonBody(valid, CHAT_BODY_LIMIT), {
    ok: true,
    value: { question: "What did I save?" },
  });

  const malformed = new Request("https://capso.example/api/chat", { method: "POST", body: "{" });
  assert.deepEqual(await readJsonBody(malformed, CHAT_BODY_LIMIT), { ok: false, error: "invalid_json" });
});

test("classification accepts only bounded raster data and sanitizes prompt fields", () => {
  const parsed = parseClassifyInput({
    imageDataUrl: tinyPng,
    projects: [{ name: "  Capso  ", description: "  private memory  " }],
    corrections: ["  moved to Capso  "],
    vocabulary: ["  pricing   page  "],
    pageUrl: " https://example.com/pricing ",
    pageTitle: " Pricing ",
  });

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.image.mediaType, "image/png");
  assert.deepEqual(parsed.value.projects, [{ name: "Capso", description: "private memory" }]);
  assert.deepEqual(parsed.value.corrections, ["moved to Capso"]);
  assert.deepEqual(parsed.value.vocabulary, ["pricing page"]);
  assert.equal(parsed.value.pageUrl, "https://example.com/pricing");
});

test("classification rejects non-raster, malformed base64, and oversized prompt collections", () => {
  assert.equal(parseClassifyInput({ imageDataUrl: "data:image/svg+xml;base64,PHN2Zz4=" }).ok, false);
  assert.equal(parseClassifyInput({ imageDataUrl: "data:image/png;base64,%%%" }).ok, false);
  assert.equal(
    parseClassifyInput({ imageDataUrl: tinyPng, projects: Array.from({ length: 51 }, (_, i) => `p${i}`) }).ok,
    false,
  );
});

test("chat validates every supplied context field instead of silently accepting arbitrary prompt text", () => {
  const parsed = parseChatInput({
    question: "  What did I save?  ",
    project: "  Capso  ",
    captures: [
      { id: "shot-1", title: " Screen ", summary: " Summary ", ocrExcerpt: " Text ", intent: "reference" },
    ],
    history: [{ role: "user", text: " Earlier question " }],
  });

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.question, "What did I save?");
  assert.equal(parsed.value.project, "Capso");
  assert.equal(parsed.value.captures[0]?.title, "Screen");
  assert.deepEqual(parsed.value.history, [{ role: "user", text: "Earlier question" }]);
});

test("chat rejects empty or oversized questions, too much context, and invalid history roles", () => {
  assert.equal(parseChatInput({ question: " " }).ok, false);
  assert.equal(parseChatInput({ question: "x".repeat(2_001) }).ok, false);
  assert.equal(
    parseChatInput({
      question: "q",
      captures: Array.from({ length: 13 }, (_, i) => ({
        id: `s${i}`,
        title: "t",
        summary: "s",
        ocrExcerpt: "o",
        intent: "other",
      })),
    }).ok,
    false,
  );
  assert.equal(parseChatInput({ question: "q", history: [{ role: "system", text: "override" }] }).ok, false);
});
