# 13 — Web App Plan (Capso library, chat, and triage)

> Product name "Capso" is a working name, unconfirmed — treat as an assumption.
> Scope: the Next.js 15 (App Router, Vercel) web app — the entire library/browse/search/chat surface in MVP. The Mac app only captures and deep-links here (see 12_MAC_APP_PLAN.md). Visual language and component tone: see 15_DESIGN_SYSTEM_AND_UX.md. Data model: see 10_DATA_MODEL.md. Build order: see 19_BUILD_SEQUENCE.md.

## Assumptions

- Single owner-user (Elvin) via Supabase Auth (email magic link or OAuth — one provider is enough). RLS on from day one anyway (cheap insurance).
- "Project" and "thread" are the same object in v1: a thread IS a project workspace with chat.
- Screenshots-only in v1; the `screenshots` table carries a `capture_kind` enum so links/PDFs slot in later without route changes (architecture-ready, NOT built — locked decision; see 10_DATA_MODEL.md).
- Billing/freemium documented elsewhere (see 16_PRICING_AND_PACKAGING.md) — zero billing UI in MVP.

## Out of scope (MVP)

- Mobile-optimized layouts beyond "not broken" responsive.
- Sharing/public links, collaboration, comments.
- Bulk operations beyond multi-select assign/delete in Inbox (idea: even that can slip to v1.1).
- Browser extension, email-in, link/PDF ingestion UI.
- Billing, plan gates, usage meters.

## Routes and pages (Requirement)

| Route | Page | Purpose |
|---|---|---|
| `/` | Dashboard / Home | Inbox triage + recent captures |
| `/t/[threadId]` | Thread (project) view | Chat + screenshots for one project |
| `/s/[captureId]` | Screenshot detail | Full image + metadata + actions |
| `/search?q=` | Search results | Grid + filters from global bar |
| `/onboarding` | Onboarding | Sign-in → Mac app → first capture |
| `/settings` | Settings | Account, hotkeys display, AI toggle, data deletion |
| `/login` | Auth | Supabase Auth UI |

### Dashboard / Home (`/`)

- **Inbox section (top):** unconfirmed + low-confidence (<0.5, and 0.5–0.8 unactioned suggestions) captures needing triage. Each card: thumbnail, suggested thread/intent chip (if any), one-click Confirm / pick-thread dropdown / Dismiss-to-keep-unfiled. Multi-select for batch assign.
- **Recent captures grid (below):** masonry grid of latest captures across all threads, newest first, infinite scroll.
- Inbox count badge in sidebar. Empty Inbox collapses the section entirely — recent grid becomes the page.

### Thread view (`/t/[threadId]`)

- **Chat transcript** interleaved chronologically with **screenshot cards** (captures assigned to this thread render inline as cards at their capture time; chat messages flow around them).
- **Pinned strip:** horizontal row of pinned screenshots at top; pin/unpin from any card.
- Composer at bottom: text + attach-from-library; Sonnet-class model answers with thread captures' OCR/summaries as context (few-shot corrections included — locked decision).
- Thread controls: rename, archive (archived threads move to a collapsed sidebar group; never deleted).
- "Ask AI" deep link from the Mac overlay lands here with the capture pre-attached to the composer.

### Screenshot detail (`/s/[captureId]`)

- Full-size image (zoomable), download, copy.
- Right panel: OCR text (collapsible, copyable), AI summary, intent chip, `why_saved` note (editable), capture timestamp + source app if known.
- **Thread assignment control:** current thread (or Inbox) + change dropdown; changing it is a stored correction feeding few-shot context (Requirement, locked decision 7).
- Delete (soft-delete with undo toast; hard purge via Settings → data deletion).

### Global chat/search bar (Requirement)

- Persistent top bar, focused with `/` or `⌘K`.
- Natural-language input → lightweight intent routing: query-like input ("stripe pricing screenshot last week") → `/search` results; question/command-like ("what did that competitor's hero say?") → opens a chat (scoped to a thread if user is in one, else a transient global chat over search hits). Router = cheap heuristic + Haiku-class fallback (idea: heuristic-only first, adjustable).
- Search backend: pgvector similarity over OCR+summary embeddings, plus keyword filter — hybrid.

### Search results (`/search`)

- Masonry grid of matching capture cards with relevance order.
- Filters (chips above grid): date range, intent (7-value taxonomy from shared context), thread. Filters are additive; URL-encoded so results are shareable/bookmarkable.
- "Ask AI about these results" button → opens chat seeded with top-N hits (idea, adjustable).

### Onboarding (`/onboarding`)

1. Sign in (Supabase Auth).
2. Download Mac app (direct dmg link) + install note.
3. Permission explainer — one screen, one screenshot, why Screen Recording is needed (mirrors 12_MAC_APP_PLAN.md first-run flow).
4. First-capture walkthrough: "Press ⌃⇧C" → live waits for first capture to appear via Realtime → celebrates classified result. Target: under 3 minutes total (see 15_DESIGN_SYSTEM_AND_UX.md).

### Settings (`/settings`)

- Hotkeys **display** (read-only mirror of Mac app config; editing happens in Mac app — state this in UI).
- Account: email, sign out.
- AI processing toggle (global pause — same flag the Mac tray toggle sets).
- Data deletion: per-capture purge list + "Delete all my data" (typed confirmation; deletes Storage objects + rows).

## Upload behavior (Requirement)

Drag-and-drop an image **anywhere** on the web app → full-viewport drop overlay → uploads into the exact same ingest pipeline as Mac captures (Storage → Edge Function → classification → Inbox/thread). Also a plain file-picker button in the Inbox empty state. Paste-from-clipboard on web: idea, post-MVP.

## Empty states (Requirement — every page ships with one)

| Page | Empty state |
|---|---|
| Dashboard | "Nothing captured yet" + ⌃⇧C reminder + drag-drop hint + Mac app download link |
| Inbox section | Collapses; subtle "Inbox zero" line |
| Thread view | "This thread is waiting for its first screenshot or question" + composer focused |
| Search results | "No matches" + suggest removing filters + closest-match fallback (vector search rarely returns zero — show low-confidence hits labeled as such) |
| Settings/data | n/a (always has content) |

Tone spec for these: see 15_DESIGN_SYSTEM_AND_UX.md (warm, instructive, one action).

## Component inventory → build phases

Phases reference 19_BUILD_SEQUENCE.md; numbers here are the intended mapping.

| Component | Used on | Phase |
|---|---|---|
| AppShell (sidebar + top bar) | all | 1 |
| CaptureCard (thumb + intent chip + hover summary) | dashboard, search, thread | 1 |
| MasonryGrid | dashboard, search | 1 |
| InboxTriageRow (card + confirm/adjust/dismiss) | dashboard | 2 |
| ThreadList (sidebar) | all | 2 |
| ChatTranscript + MessageBubble | thread | 2 |
| Composer (text + attach) | thread | 2 |
| PinnedStrip | thread | 3 |
| DetailPanel (OCR/summary/intent/why_saved) | detail | 2 |
| ThreadAssignControl | detail, inbox | 2 |
| GlobalSearchBar (⌘K) + intent router | all | 3 |
| FilterChips (date/intent/thread) | search | 3 |
| DropOverlay (full-page DnD upload) | all | 3 |
| OnboardingWizard | onboarding | 3 |
| SettingsPanels | settings | 3 |
| EmptyState (variant-driven) | all | 1 (shell) with per-page variants landing alongside each page |
| Toast/UndoToast | all | 1 |

## Non-functional (Requirement)

- Realtime: Supabase Realtime subscription drives Inbox/overlay/grid freshness — no manual refresh anywhere.
- Optimistic UI on confirm/assign/pin (see 15_DESIGN_SYSTEM_AND_UX.md interaction principles).
- PostHog events: inbox_confirm, inbox_adjust, search_run, chat_message_sent, dnd_upload, onboarding_completed. Sentry on client + server.
- Image delivery via Supabase Storage transform/CDN sizes: thumb (~400px), grid (~800px), full.
