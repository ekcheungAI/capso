# 08 — Feature Spec: Search & Retrieval

> "Later retrieve by natural language" is half the product promise. This doc specifies the search surfaces, the hybrid ranking, and the chat retrieval tool. Embeddings/OCR produced by: `06_FEATURE_SPEC_AI_MEMORY.md`. Chat context assembly that consumes retrieval: `07_FEATURE_SPEC_PROJECT_THREADS.md`. Indexes/columns: `10_DATA_MODEL.md`.

## Assumptions

- "Capso" is a working name, unconfirmed.
- Corpus scale is personal: ~10–50 captures/day → low tens of thousands of rows over years. pgvector with an HNSW index on own Supabase is comfortably sufficient; no external search infra, ever, for the personal tier.
- Query embedding uses the same model as capture embeddings (must match — see `06_FEATURE_SPEC_AI_MEMORY.md` §4).

## 1. Search surfaces (requirement)

| Surface | Where | Behavior |
|---|---|---|
| Global search | Web app, field above sidebar; Mac app menu-bar quick-search (⌃⇧F, configurable) | Searches all non-archived captures |
| Project-constrained search | Same field while inside a thread (scope toggle chip "This thread / Everywhere", default: this thread) | Adds `thread_id` filter |
| Chat retrieval | Inside thread chat, model-invoked tool | §6 |

One query box, three retrieval modes fused under it (§2–4). The user never chooses "semantic vs keyword".

## 2. Natural-language semantic search (requirement)

- Embed the query string (one embedding call, ~free) → cosine similarity vs `screenshots.embedding` via pgvector (HNSW index, `vector_cosine_ops`).
- Retrieve top 50 candidates → hand to hybrid ranker (§5).
- No query rewriting/expansion in MVP (idea: Haiku query-rewrite post-MVP if recall disappoints).

## 3. OCR keyword full-text search (requirement)

- Postgres `tsvector` over `ocr_text || ' ' || summary` (generated column, GIN index, `english` config — accepted limitation: mixed-language OCR gets `simple`-config fallback; revisit if Chinese-text screenshots become common. Flagged as assumption).
- `websearch_to_tsquery` for parsing (handles quoted phrases, natural input safely).
- Exact-ish matches matter here: error codes, prices, product names — the queries semantics fumbles.

## 4. Metadata filter extraction (requirement)

Structured filters, applied as SQL `WHERE` before ranking:

| Filter | Source | MVP |
|---|---|---|
| Date range | UI date-picker chips + lightweight NL parse of the query ("in March", "last week") via deterministic rules (chrono-style library, not an LLM call) | Yes |
| Intent / type | Filter chips (taxonomy from `06_FEATURE_SPEC_AI_MEMORY.md` §3) | Yes |
| Thread | Scope toggle / chip | Yes |
| Source app | Chip — **only if** capture metadata recorded frontmost app; MVP records it opportunistically on window captures (`captures.source_app`, nullable — see `12_MAC_APP_PLAN.md`) | Partial |
| Archived included | Off by default; explicit toggle | Yes |

When NL date parsing fires, the matched tokens are stripped from the string sent to embedding/tsquery ("pricing page I saved in March" → filter `March 1–31` + query "pricing page I saved"). The applied filter renders as a removable chip so extraction mistakes are one click to undo (requirement).

## 5. Hybrid ranking formula (requirement — starting weights, tune with usage)

Candidates = union of top-50 semantic and top-50 keyword hits (post-filter). Score per item:

```
score = 0.55 * semantic          # cosine similarity, min-max normalized over candidate set
      + 0.25 * keyword           # ts_rank_cd, min-max normalized; 0 if no keyword hit
      + 0.10 * recency           # exp(-age_days / 90)  — half-life ~62 days
      + 0.10 * revisit           # min(1, 0.25 * recency_weighted_revisits)
                                 #   revisit recency weight: event exp(-age_days/30), summed
```

- RevisitEvent kinds all count equally in MVP (`opened_detail`, `referenced_in_chat`, `copied`, `search_clicked` — see `06_FEATURE_SPEC_AI_MEMORY.md` §7). Idea: weight `referenced_in_chat` higher later.
- Keyword-only hits (zero semantic overlap) survive via the union — deliberate: exact string recall must not depend on embedding luck.
- Weights live in one config constant, logged with each search (query, weights version, top result, click) so tuning is evidence-based. Clicking a result writes `RevisitEvent(search_clicked)` — the ranking feeds itself.
- Result UI: card grid (thumbnail, summary, thread chip, date); top 3 labeled "Best matches" when `score ≥ 0.8 * top_score`; the rest chronological-within-score.

## 6. Retrieval inside chat (requirement)

Tool exposed to the Sonnet-class chat model:

```
search_memory(query: string, thread_scope: "current" | "all") -> top 5 results
  each: {capture_id, summary, ocr_excerpt (≤500 chars), why_saved,
         intent, thread_name, captured_at, thumbnail_ref}
```

- **The model decides when to call it** — no forced RAG on every turn. System prompt instructs: call when the user references past material ("that pricing screenshot", "what did the competitor's onboarding look like"), not for general questions.
- Results return as text; images are not auto-attached. The model may follow up with `fetch_capture_image(capture_id)` for up to 2 images per turn (budget rules in `07_FEATURE_SPEC_PROJECT_THREADS.md` §4).
- Same hybrid ranker as UI search; `thread_scope="current"` maps to the thread filter.
- Each returned-and-used capture logs `RevisitEvent(referenced_in_chat)`.

## 7. Example queries (requirement — acceptance-test material)

| Query | Expected behavior |
|---|---|
| "show me the pricing page I saved in March" | Date filter Mar 1–31 extracted + chip shown; semantic match on "pricing page"; keyword boost if OCR contains "pricing"; top result is that capture |
| "stripe checkout" | Keyword-dominant: OCR/tsvector hits on "Stripe" rank first even if semantic score is middling |
| "that onboarding flow with the progress checklist" | Pure semantic: matches summary "3-step onboarding checklist…" with zero keyword overlap required |
| "competitor screenshots from last week" | Intent filter `competitor` inferred? **No** — MVP does NOT infer intent filters from NL (chips only); expected: date filter `last week` + semantic match; intent chip suggested passively next to results (idea) |
| "ux bug" (as chip) + empty query | Filter-only browse: all `ux_bug` captures, recency-ordered |
| In thread "HeyOmmi", "what did their empty state look like" (chat) | Model calls `search_memory("empty state", "current")`; answers from summaries; fetches 1 image if asked to describe visually |

## 8. Latency targets (requirement)

| Operation | Target |
|---|---|
| UI search end-to-end (keystroke-debounced submit → results) | < 1.5 s p50, < 3 s p95 |
| — of which query embedding call | < 400 ms (the long pole; consider embedding-on-Edge-Function with keep-warm) |
| — of which Postgres (vector + FTS + rank) | < 200 ms at personal scale |
| Filter-only browse (no embedding needed) | < 300 ms p50 |
| `search_memory` tool round-trip inside chat | < 2 s (hidden inside model turn) |

Type-ahead instant results are **not** MVP (idea): MVP is submit-to-search. Filter-chip browsing gives the instant path.

## 9. What MVP search does NOT do (requirement — say no explicitly)

- **No color/visual-similarity search** ("that blue dashboard") — no image embeddings in MVP (`06_FEATURE_SPEC_AI_MEMORY.md` §4).
- **No OCR bounding-box highlight** — we store OCR as flat text, no coordinates; hits highlight the text panel in detail view, never overlay the image.
- **No cross-type search** — corpus is screenshots only (locked decision #1). `capture_kind` filtering UI ships only when a second kind ships.
- **No NL→intent/type filter inference** — chips only (see §7 row 4).
- **No query history / saved searches.**
- **No fuzzy spelling correction** beyond what `websearch_to_tsquery` + embeddings absorb naturally.
- **Resurfacing / weekly digest** — post-MVP flag. Hook reserved: digest selector will consume the same score formula with recency inverted (old + high-relevance + zero-revisit = "forgotten gem"). Sonnet-class, weekly, per locked decision #6. Spec'd when built; no MVP code paths.

## Out of scope

- Index/DDL specifics (HNSW params, generated columns) → `10_DATA_MODEL.md`
- Edge Function layout and keep-warm strategy → backend plan doc
- Free-tier metering of search-adjacent AI actions → pricing doc (documented, not built — locked decision #6)
