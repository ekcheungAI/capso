import { z } from "zod";

/**
 * Native auth never returns bearer or refresh tokens in the deep-link URL.
 * The Mac initiates PKCE, keeps this verifier locally, and hands this internal
 * exchange object to the future Supabase Auth adapter only after state checks.
 */
export const NATIVE_AUTH_REDIRECT_URI = "capso://auth/callback" as const;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const oauthCode = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (value) => /^[\x20-\x7e]+$/.test(value),
    "authorization code must contain printable ASCII only",
  );

export const nativeAuthExchange = z
  .object({
    code: oauthCode,
    code_verifier: z.string().regex(PKCE_VERIFIER),
    redirect_uri: z.literal(NATIVE_AUTH_REDIRECT_URI),
  })
  .strict();
export type NativeAuthExchange = z.infer<typeof nativeAuthExchange>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

export const nativeIngestSource = z.enum([
  "hotkey_region",
  "hotkey_window",
  "hotkey_fullscreen",
  "drag",
  "clipboard",
]);
export type NativeIngestSource = z.infer<typeof nativeIngestSource>;

const RFC3339_WITH_SECONDS =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const capturedAt = z
  .string()
  .regex(RFC3339_WITH_SECONDS)
  .pipe(z.iso.datetime({ offset: true }));

/**
 * POST /v1/ingest after a verified private Storage upload.
 *
 * There is deliberately no user_id. The server derives ownership from the JWT
 * and separately verifies that the owner UUID immediately after `originals/`
 * equals that authenticated id.
 */
export const nativeIngestRequest = z
  .object({
    screenshot_id: z.string().regex(UUID),
    storage_path: z.string().max(512),
    captured_at: capturedAt,
    source: nativeIngestSource,
    content_hash: z.string().regex(SHA256),
    annotated: z.boolean(),
    width: z.number().int().positive().max(100_000),
    height: z.number().int().positive().max(100_000),
    bytes: z.number().int().positive().max(26_214_400),
  })
  .strict()
  .superRefine((request, context) => {
    const parts = request.storage_path.split("/");
    const expectedName = `${request.screenshot_id}.png`;
    if (
      parts.length !== 3 ||
      parts[0] !== "originals" ||
      !UUID.test(parts[1] ?? "") ||
      parts[2] !== expectedName
    ) {
      context.addIssue({
        code: "custom",
        path: ["storage_path"],
        message: "storage_path must be originals/<authenticated UUID>/<screenshot_id>.png",
      });
    }
  });
export type NativeIngestRequest = z.infer<typeof nativeIngestRequest>;

export const nativeIngestResponse = z
  .object({
    screenshot_id: z.string().regex(UUID),
    status: z.literal("processing"),
    deduped: z.boolean(),
  })
  .strict();
export type NativeIngestResponse = z.infer<typeof nativeIngestResponse>;

export const nativeApiError = z
  .object({
    error: z
      .object({
        code: z.enum([
          "unauthorized",
          "invalid_request",
          "not_found",
          "conflict",
          "storage_quota",
          "rate_limited",
          "provider_unavailable",
          "internal",
        ]),
        message: z.string().min(1).max(512),
        retryable: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type NativeApiError = z.infer<typeof nativeApiError>;

/** Cross-language fixture envelope consumed by both Node and Rust tests. */
export const nativeContractFixture = z
  .object({
    auth_exchange: nativeAuthExchange,
    ingest_request: nativeIngestRequest,
    ingest_response: nativeIngestResponse,
    ingest_error: nativeApiError,
    invalid_boundaries: z
      .object({
        captured_at: z.array(z.string()).min(1),
        empty_api_error_message: z.literal(""),
        overlong_api_error_message_length: z.literal(513),
      })
      .strict(),
  })
  .strict()
  .superRefine((fixture, context) => {
    if (fixture.ingest_response.screenshot_id !== fixture.ingest_request.screenshot_id) {
      context.addIssue({
        code: "custom",
        path: ["ingest_response", "screenshot_id"],
        message: "ingest acknowledgement must name the exact capture",
      });
    }
  });
export type NativeContractFixture = z.infer<typeof nativeContractFixture>;
