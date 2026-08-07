import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  nativeAuthExchange,
  nativeApiError,
  nativeContractFixture,
  nativeIngestRequest,
  nativeIngestResponse,
} from "./native.ts";

const fixture = JSON.parse(
  await readFile(
    new URL("../fixtures/native-authenticated-ingest.json", import.meta.url),
    "utf8",
  ),
);

test("shared Zod owns the exact native auth and ingest fixture", () => {
  const parsed = nativeContractFixture.parse(fixture);
  assert.equal(parsed.auth_exchange.redirect_uri, "capso://auth/callback");
  assert.equal(parsed.ingest_request.source, "hotkey_fullscreen");
  assert.equal(parsed.ingest_response.screenshot_id, parsed.ingest_request.screenshot_id);
  assert.equal(nativeApiError.parse(parsed.ingest_error).error.code, "storage_quota");
  for (const capturedAt of parsed.invalid_boundaries.captured_at) {
    assert.equal(
      nativeIngestRequest.safeParse({
        ...parsed.ingest_request,
        captured_at: capturedAt,
      }).success,
      false,
    );
  }
  for (const message of [
    parsed.invalid_boundaries.empty_api_error_message,
    "x".repeat(parsed.invalid_boundaries.overlong_api_error_message_length),
  ]) {
    assert.equal(
      nativeApiError.safeParse({
        error: { ...parsed.ingest_error.error, message },
      }).success,
      false,
    );
  }
});

test("authenticated ingest never accepts caller-supplied ownership", () => {
  assert.equal(
    nativeIngestRequest.safeParse({
      ...fixture.ingest_request,
      user_id: "018f22c4-cada-7c6b-9d5b-fc35f7f92279",
    }).success,
    false,
  );
  assert.equal(
    nativeIngestRequest.safeParse({
      ...fixture.ingest_request,
      storage_path: fixture.ingest_request.storage_path.replace(
        fixture.ingest_request.screenshot_id,
        "018f22c4-cada-7c6b-9d5b-fc35f7f92271",
      ),
    }).success,
    false,
  );
  assert.equal(
    nativeIngestRequest.safeParse({
      ...fixture.ingest_request,
      captured_at: "2026-02-30T10:00:00+08:00",
    }).success,
    false,
  );
});

test("tokens are absent from the callback exchange and response acknowledgement is exact", () => {
  assert.equal(
    nativeAuthExchange.safeParse({
      ...fixture.auth_exchange,
      code: "+/=:!",
    }).success,
    true,
  );
  assert.equal(
    nativeAuthExchange.safeParse({
      ...fixture.auth_exchange,
      code: "bad\u0000code",
    }).success,
    false,
  );
  assert.equal(
    nativeAuthExchange.safeParse({
      ...fixture.auth_exchange,
      access_token: "must-never-cross-the-deep-link",
    }).success,
    false,
  );
  assert.equal(
    nativeIngestResponse.safeParse({
      ...fixture.ingest_response,
      user_id: "018f22c4-cada-7c6b-9d5b-fc35f7f92279",
    }).success,
    false,
  );
});
