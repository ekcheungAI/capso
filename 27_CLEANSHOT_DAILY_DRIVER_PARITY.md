# 27 — CleanShot Daily-Driver Parity

> Owner-approved working contract, 2026-08-08. This supplements `04_MVP_SCOPE.md`,
> `05_FEATURE_SPEC_CAPTURE.md`, `12_MAC_APP_PLAN.md`, and `21_ACCEPTANCE_CRITERIA.md`.
> It defines the narrower claim “Elvin can stop using CleanShot X for daily screenshots,”
> not feature-for-feature parity with the full CleanShot product.

## Reference and clean-room boundary

- Golden reference installed locally: `/Applications/Setapp/CleanShot X.app`, version 4.8.8,
  bundle `com.getcleanshot.app-setapp`, universal binary, Developer ID signed and notarized.
- Treat CleanShot as a black-box UX reference only. Observe user-visible timing, focus,
  placement, gestures, keyboard flow, and failure behavior.
- Never extract, decompile, copy, or redistribute CleanShot code, icons, sounds, text,
  layouts, or other proprietary assets. Capso keeps its own brand and implementation.
- Automated hourly runs must not invoke CleanShot capture modes or alter its settings;
  those actions interrupt the foreground user. Black-box comparisons happen only in an
  explicit interactive QA session or from previously recorded evidence.

## The replacement promise

Capso replaces the daily screenshot path when it can do this reliably:

```text
hotkey → region/window/fullscreen selection → clipboard + non-activating overlay (<1s)
→ optional arrow/box/text/blur → durable local queue → cloud library
→ background OCR/classification/project suggestion with no browser tab open
→ user correction improves a later similar suggestion
```

“Background learning” begins only after an intentional capture. Capso does not
continuously observe, sample, record, or ingest the screen.

## Required experience

| Gate | Required behavior | Evidence |
|---|---|---|
| UX-01 | Menu-bar app is always available, has no Dock presence, and launches at login only after opt-in. | Native manual QA |
| CAP-01 | Configurable global shortcuts capture region, window, and fullscreen from any foreground app. Escape cancels silently. | Native integration + manual QA |
| CAP-02 | Successful captures reach the clipboard and a thumbnail overlay in under 1 second. | 20-capture latency run |
| OVL-01 | Overlay appears on the capture display, stays above windows, never steals focus, supports Copy, Save, Annotate, drag-out, and Close, and can be restored from recent history. | Focus/multi-display/manual QA |
| ANN-01 | Arrow, box, text, and irreversible blur work; saved/copied/uploaded pixels are the flattened result. | Pixel test + manual QA |
| DUR-01 | Original pixels are persisted locally before any network or AI call. Offline captures survive restart, retry idempotently, and are deleted locally only after confirmed remote persistence. | Automated queue test + offline drill |
| HIS-01 | Every successful capture is recoverable from Capso history/library with timestamp and original pixels; the menu exposes the eight most recent local records instantly. | Integration + manual QA |
| AI-01 | Upload, OCR, summary, intent, tags, and project routing complete in the background while all Capso browser tabs are closed. | End-to-end native test |
| LRN-01 | Three equivalent project corrections cause the fourth similar capture to use the corrected destination, matching AC-COR-01. | Scripted evaluation |
| RET-01 | OCR exact-text and vague-memory queries retrieve the expected capture under the existing search gates. | Golden query evaluation |
| PKG-01 | A correctly identified, Developer ID signed, notarized DMG installs and completes onboarding on a fresh macOS user without external instructions. | Gatekeeper + fresh-user QA |

## Explicit non-goals for the cancellation gate

- Scrolling capture.
- Screen recording, GIF, microphone, camera, or computer audio.
- Multiple or restart-persistent floating pinned screenshots; the one-pin v1 remains a dogfood feature until physical QA passes.
- CleanShot Cloud-compatible sharing or public links.
- Background/social-post composition tool.
- Full CleanShot annotation breadth, editable CleanShot project files, or exact UI cloning.
- Passive screen observation.

These can be reconsidered only after the five-day dogfood gate. They do not block
Elvin from cancelling CleanShot for the agreed daily screenshot workflow.

## Five-day dogfood exit gate

The hourly build loop stops only when all of the following are true:

1. Every gate above is PASS with linked evidence; no required check is skipped.
2. Elvin uses Capso instead of CleanShot capture shortcuts for five consecutive workdays.
3. The period contains at least 50 real captures, including region, window, fullscreen,
   annotation, multi-display, and one offline/restart/reconnect sequence.
4. Zero captures are lost or duplicated; every capture remains copyable and recoverable.
5. Capture-to-overlay is <1s for all 20 measured samples; suggestion latency meets
   `<5s p50 / <8s p90`; keyword-searchable latency is <30s.
6. The scripted three-correction learning sequence passes.
7. There are no unresolved P0/P1 defects in capture, clipboard, overlay, durability,
   authentication, processing, retrieval, permissions, signing, or installation.

Passing this gate means “safe for Elvin to cancel CleanShot for daily screenshots.” It
does not authorize publishing Capso, sending a build to testers, changing production,
or uninstalling CleanShot without separate approval.
