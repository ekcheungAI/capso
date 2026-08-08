import assert from "node:assert/strict";
import { MiniMaxClassificationProvider } from "./minimax.ts";

const CALL = {
  system: "system boundary",
  prompt: "classify it",
  image: { mediaType: "image/png", base64: "iVBORw0KGgo=" },
  repairError: null,
};

Deno.test("MiniMax adapter sends exact in-memory pixels and strips private reasoning", async () => {
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const provider = new MiniMaxClassificationProvider({
    apiKey: "secret-test-key",
    model: "MiniMax-M3-test",
    fetcher: (input, init) => {
      requestedUrl = String(input);
      requestedInit = init;
      return Promise.resolve(Response.json({
        content: [{ type: "text", text: '<think>private</think>{"ok":true}' }],
      }));
    },
  });

  assert.equal(await provider.classify(CALL), '{"ok":true}');
  assert.equal(requestedUrl, "https://api.minimax.io/anthropic/v1/messages");
  assert.ok(!requestedUrl.includes("secret-test-key"));
  const headers = requestedInit?.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], "secret-test-key");
  const body = JSON.parse(String(requestedInit?.body));
  assert.equal(body.model, "MiniMax-M3-test");
  assert.equal(body.messages[0].content[1].source.data, CALL.image.base64);
});

Deno.test("provider failures never persist or throw the response body", async () => {
  const provider = new MiniMaxClassificationProvider({
    apiKey: "secret-test-key",
    fetcher: () =>
      Promise.resolve(new Response("provider secret body", { status: 500 })),
  });

  await assert.rejects(
    () => provider.classify({ ...CALL, repairError: "schema failed" }),
    (error: unknown) => {
      assert.match(String(error), /unavailable \(500\)/);
      assert.doesNotMatch(String(error), /provider secret body/);
      return true;
    },
  );
});
