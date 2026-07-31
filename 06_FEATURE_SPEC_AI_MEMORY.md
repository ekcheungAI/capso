# 06 — Feature Spec: AI Memory

> The pipeline that turns a raw PNG into searchable, chat-ready memory. Capture flow feeding this: `05_FEATURE_SPEC_CAPTURE.md`. Thread matching consumes this doc's outputs: `07_FEATURE_SPEC_PROJECT_THREADS.md`. Ranking consumes embeddings + revisit signals: `08_FEATURE_SPEC_SEARCH_AND_RETRIEVAL.md`. Tables: `10_DATA_MODEL.md`.

## Assumptions

- "Capso" is a working name, unconfirmed.
- Haiku-class multimodal model reliably returns valid structured JSON with a strict schema prompt + one retry; we do not build a bespoke OCR pipeline in MVP.
- Cost envelope: ≤ US$0.01 per capture (one cheap vision call + one embedding call) — locked decision.
- AI providers see images transiently; nothing about provider-side retention is configurable in MVP (locked decision #4).

## 1. Per-capture cheap pass (requirement)

Exactly **one** Haiku-class multimodal call per capture, invoked by a Supabase Edge Function when the upload lands (jobs table row → processed by worker; pg_cron sweeps stragglers). Input: the uploaded PNG + few-shot correction examples (§6) + thread candidate list (names + one-line descriptions, for `project_suggestion`).

### Output JSON schema (requirement — this is the contract)

```json
{
  "ocr_text":            "string  — all legible text, reading order, verbatim; empty string if none",
  "summary":             "string  — 1–2 sentences, what this screenshot shows and its salient point",
  "type":                "string  — enum: ui_screen | web_page | chat | document | chart | code | photo | other",
  "intent":              "string  — enum: design_inspiration | ux_bug | competitor | marketing_hook | content_idea | reference | other",
  "project_suggestion":  "string | null — exact name of one candidate thread, or null (propose new/Inbox)",
  "confidence":          "number  — 0.0–1.0, confidence in project_suggestion (not in intent)",
  "why_saved":           "string  — one line, ≤120 chars: why the user likely captured this"
}
```

Validation (requirement): parse strictly; on invalid JSON retry once with an appended "return only valid JSON" nudge; on second failure mark job `failed_classification`, item stays in Inbox with no metadata, retried by cron up to 3 times over 30 min, then surfaced as "unprocessed" in UI.

### Confidence routing (locked decision)

| Confidence | Behavior |
|---|---|
| ≥ 0.8 | Auto-assign to suggested thread (editable); overlay chip shows `confirmed` state |
| 0.5–0.8 | Overlay chip shows `suggestion` (confirm/adjust) |
| < 0.5 | Inbox; no chip suggestion (chip shows "Saved to Inbox") |

## 2. OCR handling (requirement)

- OCR comes from the **same vision call** (`ocr_text` field). No separate OCR service in MVP.
- Stored in `captures.ocr_text` (text column) + indexed into a `tsvector` for keyword search (see `08_FEATURE_SPEC_SEARCH_AND_RETRIEVAL.md`).
- Tradeoff, stated: LLM OCR is worse than dedicated OCR on dense/small text and costs tokens, but collapses two calls into one and is "good enough" for search recall. **Post-MVP cost optimization (idea)**: run Apple Vision framework OCR on-device in the Mac app, ship `ocr_text` up with the capture, and drop that field from the LLM call — cuts output tokens (the dominant cost) and improves dense-text accuracy. Architecture note: keep `ocr_source` enum (`llm | apple_vision`) on the row from day one so the switch is non-breaking.
- Blurred regions (annotation) are pixelated before upload, so OCR never sees them — documented user-facing behavior (see `05_FEATURE_SPEC_CAPTURE.md` §3).

## 3. Summary, type, intent, why_saved (requirement)

- **summary**: 1–2 sentences, written for retrieval ("Stripe pricing page showing the new usage-based tier at $0.30/unit"), not description-for-the-blind. This is the primary embedded text and the card subtitle in UI.
- **type**: what the image *is* (mechanical). **intent**: why it was *saved* (motivational) — uses the locked taxonomy: `design_inspiration, ux_bug, competitor, marketing_hook, content_idea, reference, other`. Both are filterable metadata.
- **why_saved**: one-liner shown on hover/detail ("Competitor's onboarding uses a 3-step checklist — steal the pattern"). It is a guess; corrections to intent implicitly correct it over time via few-shot examples. Not separately editable in MVP (idea: inline edit post-MVP).
- Taxonomy is fixed in MVP — no user-defined intents (idea: custom intents post-MVP; schema uses text column, not DB enum, to keep that door open — see `10_DATA_MODEL.md`).

## 4. Memory extraction / embedding (requirement)

One embedding call per capture, over a composed document:

```
{summary}
Intent: {intent}. Type: {type}.
{first ~1,500 chars of ocr_text}
```

- Single embedding per capture, stored in pgvector (`captures.embedding`). No image embeddings in MVP (idea: CLIP-style visual embedding post-MVP for "looks like" search).
- OCR excerpt is truncated, not summarized — cheap and deterministic. 1,500 chars ≈ enough for headlines/pricing/labels, which is what queries target.
- Re-embedding triggers: user edits summary (not in MVP UI) or intent correction → re-embed with corrected intent line. Keep it: corrections are rare and re-embeds cost fractions of a cent.

## 5. Next-action suggestions (post-MVP — idea, flagged)

Not built in MVP. When built: appears **only inside thread chat** (never push notifications), e.g. "You've saved 4 competitor pricing screenshots this week — want a comparison table?" Sonnet-class, on-demand. Recorded here so the chat context assembly in `07_FEATURE_SPEC_PROJECT_THREADS.md` reserves no MVP work for it.

## 6. User-correction learning loop (requirement — locked decision #7)

No fine-tuning. Pure few-shot injection.

1. Every overlay/library action that confirms or changes `project` or `intent` writes a `UserCorrection` row: `{capture_id, field, ai_value, user_value, was_ai_accepted, created_at}` (see `10_DATA_MODEL.md`).
2. Classification prompt injects the **most recent N = 20 corrections** (both accepts and overrides; overrides weighted by recency — simplest version: last 20 rows, whatever they are) as compact few-shot lines:
   `"Screenshot summarized as '<summary>' → user filed it under project '<user_value>', intent '<intent>'."`
3. **Metric (requirement)**: suggestion acceptance rate = accepted ÷ (accepted + overridden), computed weekly from UserCorrection. Target: >70% by week 4 of daily use. If acceptance stays <50%, the fix is prompt/threshold tuning, not more ML.
4. Corrections are per-user (single user in MVP) and never leave own Supabase except inside prompts.

## 7. Revisit ranking (requirement)

- Every meaningful re-engagement with a capture writes a `RevisitEvent` row: `{capture_id, kind: opened_detail | referenced_in_chat | copied | search_clicked, created_at}`.
- Consumed in two places: (a) search ranking boost — formula in `08_FEATURE_SPEC_SEARCH_AND_RETRIEVAL.md`; (b) weekly digest selection (post-MVP) — high-revisit and zero-revisit-but-high-relevance items are both digest candidates.
- Cheap by design: insert-only table, aggregated at query time (count + recency-decayed weight); no counters to keep consistent.

## 8. Classification prompt — draft (sketch, expected to be tuned)

System:

```
You are the capture-classifier for a personal screenshot memory tool. The user
is a solo marketer/founder/product-builder. You receive one screenshot. Return
ONLY a JSON object matching the schema below. No markdown, no commentary.

Schema:
{"ocr_text": string, "summary": string, "type": one of [ui_screen, web_page,
chat, document, chart, code, photo, other], "intent": one of
[design_inspiration, ux_bug, competitor, marketing_hook, content_idea,
reference, other], "project_suggestion": string or null, "confidence": number
0..1, "why_saved": string}

Rules:
- ocr_text: transcribe all legible text verbatim, reading order. "" if none.
- summary: 1-2 sentences. Name concrete things (products, prices, features).
- intent is WHY the user saved it, not what it depicts.
- project_suggestion: pick EXACTLY one name from the candidate list, or null
  if none fits. Never invent a name.
- confidence reflects project_suggestion only. Use <0.5 when genuinely unsure.
- why_saved: <=120 chars, direct, useful ("Pricing anchor for the launch page").
```

User message (per call):

```
Candidate projects:
{for each thread: "- {name}: {one_line_description}"}

Recent filing decisions by this user:
{most recent 20 UserCorrection few-shot lines, per §6}

Classify the attached screenshot.
```

## Out of scope

- Chat-turn prompts and context assembly → `07_FEATURE_SPEC_PROJECT_THREADS.md`
- Hybrid search formula → `08_FEATURE_SPEC_SEARCH_AND_RETRIEVAL.md`
- Weekly digest (Sonnet-class, post-MVP) → roadmap doc
- Sensitive-exclude / app blocklist → post-MVP privacy work (locked decision #4)
- Fine-tuning, custom taxonomies, image embeddings — explicitly not MVP
