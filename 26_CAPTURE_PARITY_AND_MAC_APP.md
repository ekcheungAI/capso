# 26 — Capture parity across surfaces (and what the Mac app needs)

> Status: plan, 2026-08-02. Siblings: 04_MVP_SCOPE.md (M1–M11, the litmus test),
> 05_FEATURE_SPEC_CAPTURE.md, 11_ARCHITECTURE.md, 14_BACKEND_AND_STORAGE.md.
> Project root: `~/Desktop/ekOS/20_projects/Capso`

## The invariant

**Two surfaces capturing the same screen must produce the same stored artefact.**
Same pixel dimensions, same encoding, same aspect bucket, same content hash, same
classification path.

Anything less and: dedupe misfires, thumbnails differ in size depending on where the hotkey was
pressed, the grid reflows differently for the same image, and the classifier sees systematically
different inputs by surface. None of that is visible in review — it only shows up as a library that
feels subtly inconsistent.

There are three capture surfaces today (Chrome extension, web drag/paste, sample generator) and M1
adds a fourth. This doc records what is now shared, and what still is not.

## Done (2026-08-02)

`packages/shared/src/capture.ts` is the single definition of capture geometry, encoding and
transport. Before it, `MAX_EDGE = 1600` and the JPEG quality were declared independently in
`apps/extension/capture.js` and `apps/web/components/capture.tsx`, tied together only by a comment
claiming they matched — and the aspect thresholds existed in a **third** place, the store's row
mapper, so a capture could bucket one way when taken and another when read back.

- Shared: `MAX_EDGE`, `FULL_QUALITY`, `FULL_TYPE`, `THUMB_EDGE`, `THUMB_QUALITY`, `THUMB_TYPE`,
  `fitWithin()`, `aspectOf()`, `contentHash()`, `captureSource`, `ingestPayload`.
- The extension ships unbundled, so `scripts/gen-capture-spec.mjs` mirrors the spec into
  `apps/extension/capture-spec.generated.js` — same mechanism as `gen-tokens.mjs`, and
  `pnpm capture:check` fails `lint` if it drifts.
- `apps/web/lib/capture-spec.check.ts` runs both implementations over the same inputs, so a
  generator that emitted *subtly different arithmetic* fails the test run rather than shipping.
  A byte-comparison alone would not catch that.
- **`content_hash` is now actually written.** It was computed by the extension, sent, validated by
  `/api/ingest`, carried through the queue — and then dropped by the drain, with `start()`
  hardcoding `contentHash: null`. It is now computed at the end of the one pipeline every capture
  goes through, so it always describes the bytes actually in Storage.

## Gap 1 — Classification only happens in a browser tab (blocks M1)

**The single biggest obstacle to the Mac app.**

`classify()` has exactly two callers: `components/capture.tsx` and `lib/reclassify.ts`. Both run in
the browser. There is no server-side worker — `19_BUILD_SEQUENCE.md`'s "jobs table + pg_cron + Edge
Function worker skeleton" was never built.

The consequence for each surface:

| Surface | How its captures get classified today |
|---|---|
| Web drag/paste | In the tab that made it |
| Chrome extension | Only when a Capso tab is open to drain the relay and run classify for it |
| **Mac app (M1)** | **Nothing would classify it.** A capture written straight to Supabase stays `pending` forever |

A menu-bar capture tool that silently requires a browser tab to be open before your screenshot gains
a title, OCR text or a project is not the product described in `01_PRODUCT_BRIEF.md`.

**Feature needed: server-side classification.** A capture row lands as `processing_status: 'pending'`
and something server-side picks it up, regardless of origin and with no tab open. Either the jobs
table + `pg_cron` + Edge Function of `11_ARCHITECTURE.md`, or — cheaper first step — an authenticated
route the ingest call triggers directly.

This also fixes the extension's current weakness, so it is not Mac-only work.

## Gap 2 — The Mac app forces the authentication decision

Anonymous Supabase sessions (chosen 2026-08-01 so the demo stays open) are a *browser* mechanism:
the session lives in that browser profile's storage. A native app cannot join it.

So M1 implies one of:

1. **Real accounts** (magic link) — the Mac app signs in properly. Cleanest, and where the product
   goes anyway; it also closes the currently-unauthenticated `/api/classify` and `/api/chat`.
2. **Device pairing** — the Mac app holds a device token, as the extension already does, and posts to
   a relay. Preserves the open demo but keeps a second identity model alive indefinitely.

Recommendation: **(1), decided before M1 starts, not during.** Note it reverses part of the
"keep the demo open" decision, so it is the owner's call. Related: `18_RISKS_AND_OPEN_QUESTIONS.md`
Q4 (distribution) and Q5 (first external testers).

## Gap 3 — The relay is right for now and wrong later

`/api/ingest` exists because "a service worker cannot write to *the web app's* origin storage". Its
docstring says this "remains true after the Supabase migration". That is true only while identity is
per-browser: once there are real accounts (Gap 2), the extension can hold its own session and write
to Supabase directly, and the relay becomes a hop that buys nothing.

Not a bug — a correct decision with an expiry date. **Re-evaluate the relay when Gap 2 is resolved**,
and do not build the Mac app onto it by default.

## Gap 4 — Captures are encoded twice on the extension path

The extension downscales to fit Vercel's 4.5 MB body limit; the web app then decodes and re-encodes
the same image through `downscale()`. Two lossy JPEG passes for every browser capture, and the
extension's `width`/`height` are recomputed and its hash discarded.

Once Gap 1 and Gap 2 land, the capture surface should encode **once**, to the shared spec, and upload
the final bytes. The Mac app should be built that way from the start rather than inheriting the
double-encode.

## Sequencing

Gap 1 and Gap 2 are the real prerequisites for M1; Gaps 3 and 4 are consequences that resolve once
those two are decided.

1. **Decide Gap 2** (auth model). Blocks everything else and is a decision, not code.
2. **Build Gap 1** (server-side classification). Independently valuable — it fixes the extension's
   dependence on an open tab even if M1 slips.
3. **Then M1**, encoding once against the shared spec, writing directly to Supabase.
4. **Retire the relay** (Gap 3) once the extension can authenticate.

## What is deliberately not here

Native capture engine, annotation (M2), scrolling capture — all already placed in
`04_MVP_SCOPE.md`. This doc is only about the surfaces agreeing with each other.
