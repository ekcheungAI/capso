# 07 — Feature Spec: Project Threads

> ProjectThread is the organizing primitive of Capso: part folder, part chat, zero-folder in feel (mymind-style calm — borrow, don't clone). Classification that feeds suggestions: `06_FEATURE_SPEC_AI_MEMORY.md`. Search inside chat: `08_FEATURE_SPEC_SEARCH_AND_RETRIEVAL.md`. Capture-time overlay: `05_FEATURE_SPEC_CAPTURE.md`. Tables: `10_DATA_MODEL.md`.

## Assumptions

- "Capso" is a working name, unconfirmed.
- Owner-user runs ~3–10 active threads (matches his real project load); UI is not designed for 100+ threads.
- Chat model is Sonnet-class per locked decision #6 routing (Sonnet only for chat turns and digests).

## 1. ProjectThread as first-class object (requirement)

A ProjectThread is one row (`project_threads`) owning:

- `name`, `one_line_description` (used verbatim in the classifier's candidate list — see `06_FEATURE_SPEC_AI_MEMORY.md` §8; keep descriptions honest, they do real work)
- `centroid_embedding` (pgvector) — running mean of member-capture embeddings, recomputed on attach/detach (cheap at this scale: full recompute, no incremental math needed)
- `system_summary` — a rolling 3–6 sentence AI-maintained summary of what this thread is about, regenerated (Haiku-class) when the thread gains 10 new captures or on manual "refresh summary" (idea: also on rename)
- `status`: `active | archived`
- `last_active_at` — bumped by capture attach or chat message
- messages (`thread_messages`) and captures (`screenshots.thread_id` FK)

**Inbox** is a real, undeletable, unarchivable system thread per user (simplest model: same table, `is_inbox = true`). Everything unclassified lives there. Inbox has no chat in MVP — chatting requires filing (keeps context assembly sane; idea: allow Inbox chat later).

## 2. How screenshots attach (requirement)

| Path | Mechanism |
|---|---|
| AI suggestion at capture | Overlay chip confirm / auto-assign ≥0.8 (see `05_FEATURE_SPEC_CAPTURE.md` §2) |
| Manual move | From library/search/detail view: "Move to thread" picker; from Inbox triage view: keyboard-first (j/k navigate, ⏎ accept suggestion, number keys pick thread) |
| Manual at capture | Overlay ⌄ adjust dropdown |

Rules:
- **One thread per screenshot + Inbox fallback. Multi-assign is NOT in MVP** (locked decision). Schema stays a plain FK, not a join table — if multi-assign ever ships it is a migration, and that is accepted (`10_DATA_MODEL.md` notes this).
- Every attach/detach/confirm writes a `UserCorrection` row (learning loop — `06_FEATURE_SPEC_AI_MEMORY.md` §6).
- Moving a capture updates both threads' centroids and bumps destination `last_active_at`.

## 3. Project suggestion / confirmation mechanics (requirement)

Two signals combine at classification time:

1. **Embedding similarity**: capture's composed-text embedding vs each active thread's `centroid_embedding` (cosine). Computed in the Edge Function *after* the cheap pass returns (it needs the embedding).
2. **LLM judgment**: the classifier's `project_suggestion` + `confidence`, informed by candidate list + few-shot corrections.

Resolution logic (requirement — starting values, tune against acceptance rate):

- If LLM suggestion and top-centroid match agree → use LLM confidence as-is.
- If they disagree → cap confidence at 0.79 (forces overlay confirm, never silent auto-assign on conflict).
- If no centroid similarity ≥ **0.75** AND LLM returned null → **new-thread proposal**: overlay chip offers "New thread: '<LLM-drafted name>'?" (LLM drafts name from summary; user can rename inline before confirming). Decline → Inbox.
- Threads with <3 captures have unreliable centroids → rely on LLM signal alone until n≥3.

Confirmation UX contract: confirm is always one click/keystroke; adjusting is always ≤2. Nothing about filing may ever require opening the main app window at capture time.

## 4. Chat inside a thread (requirement)

"Ask AI" on the overlay, or the composer at the bottom of any thread, opens/continues that thread's single ongoing chat transcript (one conversation per thread — no sub-conversations in MVP).

### Context assembly per chat turn (requirement — token budget rules)

Budget target ≤ ~12k input tokens/turn (cost control; Sonnet-class). Assembled in priority order — lower items get truncated first:

| Priority | Component | Budget |
|---|---|---|
| 1 | System prompt (product persona + tool instructions) | ~400 tokens |
| 2 | Thread `system_summary` | ~300 tokens |
| 3 | Explicitly attached/referenced screenshots: **actual images** (max 3 per turn, most recent first) + their summaries/OCR excerpts | ~4k tokens |
| 4 | Last N = 12 chat messages (verbatim; older history is represented only by system_summary) | ~3k tokens |
| 5 | Retrieved memory: top 5 `search_memory` results as text (summary + OCR excerpt + why_saved + date) — images NOT sent for retrieved items unless the model explicitly requests one via tool call, max 2 extra | ~3k tokens |

Rules:
- Images are the expensive part; hard cap 5 images per turn total. Beyond that, text summaries only.
- `search_memory(query, thread_scope)` is a model-invoked tool (definition in `08_FEATURE_SPEC_SEARCH_AND_RETRIEVAL.md` §6); default scope = current thread; model may request global scope.
- Every capture referenced in a chat turn writes a `RevisitEvent` (`referenced_in_chat`).
- Free-tier metering counts chat turns as "AI actions" (documented, not enforced by billing in MVP — locked decision #6).

## 5. Thread UI feel (requirement-level layout, idea-level polish)

Benchmark: mymind's calm density — generous whitespace, no folder chrome, no badges screaming counts.

- **Main view = chat transcript interleaved with screenshot cards** in chronological order: a captured screenshot appears in the flow as a card (thumbnail + summary + intent chip + why_saved on hover) at its capture time; chat messages flow around them. The thread reads as a diary of the project.
- **Pinned gallery strip** across the top: horizontally scrollable thumbnails of pinned captures (manual pin; max 12). One click opens detail lightbox (full-res, OCR text panel, copy buttons, move/delete).
- Composer at bottom, always visible. Drag an image into the composer = capture into this thread + attach to the drafted message.
- Screenshot cards have quick actions on hover: pin, move, copy image, copy OCR, delete (undo toast).

## 6. Browsing between projects (requirement)

- Left sidebar: **Inbox pinned on top** (with unfiled count — the one number allowed to demand attention), then active threads in **most-recently-active order**. No manual reordering, no nesting, no drag-sort in MVP.
- Inbox click → triage view (§2 keyboard flow), not a chat.
- Global search field above the sidebar (see `08_FEATURE_SPEC_SEARCH_AND_RETRIEVAL.md`).
- Archived threads live behind a collapsed "Archived" section; excluded from classifier candidate list, centroid matching, and default search scope (searchable via explicit filter).
- Mac menu-bar app shows a compact thread list (recent 5 + Inbox) for filing; full browsing happens on web. Split of surfaces detailed in `12_MAC_APP_PLAN.md`.

## 7. Thread lifecycle (requirement)

| Operation | MVP? | Behavior |
|---|---|---|
| Create | Yes | From new-thread proposal (§3), sidebar "+", or overlay picker "New thread…" |
| Rename | Yes | Inline; classifier candidate list uses new name immediately; few-shot correction lines store thread IDs, so history survives renames |
| Archive | Yes | Hides from sidebar/classifier/search-default; fully reversible; chat and captures untouched |
| Merge | **Post-MVP** | Planned: pick source→target, captures re-file, transcripts concatenate with divider, centroid recomputes. Not built in MVP; manual workaround = multi-select captures → move, then archive the husk |
| Delete | Yes, guarded | Only empty threads (0 captures) deletable; otherwise archive. Captures are never cascade-deleted by thread operations |

## 8. Empty states & success signals

- **Empty thread** (just created): shows the drafted `one_line_description` for inline edit + a hint ("Captures filed here will appear in the flow. ⌃⇧C to capture."). No sample content, no illustrations — calm.
- **Empty Inbox**: the goal state. Show a quiet checkmark, nothing else (idea: mymind-style single line of copy).
- **Success metrics** (requirement, measured from existing rows — no extra instrumentation):
  - Suggestion acceptance rate >70% by week 4 (`UserCorrection`, see `06_FEATURE_SPEC_AI_MEMORY.md` §6)
  - Inbox unfiled count trends toward 0 within 48h of capture (staleness query on `screenshots`)
  - ≥3 chat turns/week that trigger `RevisitEvent(referenced_in_chat)` — proves memory is being *used*, not hoarded

## Out of scope

- Sharing/collaboration on threads — not in MVP, SaaS-later concern only.
- Cross-thread chat ("ask across all projects") — post-MVP; global `search_memory` scope inside a thread chat is the MVP-shaped hole for it.
- Digest generation per thread — post-MVP (see `06_FEATURE_SPEC_AI_MEMORY.md` §7).
- Auto-archiving stale threads — never automatic; suggestions at most (idea).
