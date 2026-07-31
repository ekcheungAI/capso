# 15 — Design System & UX (Capso)

> Product name "Capso" is a working name, unconfirmed — treat as an assumption.
> Scope: shared design language for the web app (13_WEB_APP_PLAN.md) and the Mac overlay/menus (12_MAC_APP_PLAN.md). Benchmark: mymind.com — borrow calm, beauty, privacy-feel, zero-folder ethos. **Borrow qualities, don't clone** (Requirement).

## Assumptions

- One user (Elvin), one taste. Optimize for his daily comfort, not broad-market neutrality.
- Web is the primary design surface; Mac overlay inherits the same tokens at smaller scale.
- Tailwind + shadcn-style primitives as implementation substrate (idea — swap if the build agent prefers, but keep the tokens).

## Out of scope

- Marketing site design.
- Mascot/character design (explicitly post-MVP — see AI presence below).
- Full a11y audit (baseline only in MVP: contrast, focus rings, keyboard nav for triage/search).

## Design principles (Requirement)

1. **Calm over busy.** Fewer elements per screen than feels safe. If a screen has two competing focal points, cut one.
2. **Memory, not filing.** No folders, no tag managers, no taxonomy chores. The user captures and confirms; the system organizes.
3. **AI suggests, user confirms.** AI output is always presented as a dismissible suggestion chip, never a silent mutation (auto-assign ≥0.8 is the one exception, and it's always visibly undoable).
4. **Speed = trust for capture.** Any latency or friction at capture time erodes the whole product. Capture path never waits on network, AI, or animation.
5. **Screenshots are the hero — chrome recedes.** UI is a quiet frame: neutral surfaces, thin borders, images carry the color.

## UI tone

- Voice: warm, brief, first-person-plural avoided; sounds like a sharp assistant, not a system. "Saved — I'll file it" not "Item uploaded successfully."
- No exclamation-mark enthusiasm, no corporate hedging, no error-code language at the surface (codes go to tooltips/logs).
- Microcopy budget: one line. If it needs two, it needs a redesign.

## Layout style (Requirement)

- Generous whitespace; content max-width generous but never edge-to-edge dense.
- **Masonry / moodboard grid** for capture browsing (dashboard, search) — variable-height cards, uniform gutters, no visible card chrome until hover.
- **Single accent color** used only for: primary actions, active states, AI suggestion chips. Everything else neutral.
- **Light + dark** from day one, token-driven. Dark is expected default for the owner-user (assumption); both must be first-class.

## Navigation structure (Requirement)

- **Left sidebar:** Inbox (with count badge) → All captures → thread list (recency-ordered, archived collapsed at bottom). No nesting, ever.
- **Top bar:** global search/chat input (⌘K), nothing else competing with it.
- No breadcrumbs; back = browser back. Detail views open in-place (route) with escape-to-return.

## Card patterns (Requirement)

Screenshot card = **image + intent chip + one-line summary on hover**:

- Resting: just the image, rounded corners, hairline border.
- Hover: bottom gradient scrim → one-line AI summary + intent chip + quick actions (pin, open thread).
- Unconfirmed (Inbox) card additionally shows the suggestion chip inline with Confirm/adjust affordances — the chip IS the call to action.
- Intent chips: 7-value taxonomy (design_inspiration, ux_bug, competitor, marketing_hook, content_idea, reference, other); chip color = tinted neutral, not 7 rainbow colors (idea: subtle per-intent icon instead — adjustable).

## Thread patterns (Requirement)

- Chat bubbles: user right-aligned accent-tinted; AI left-aligned neutral, no avatar image in MVP (see AI presence).
- **Inline screenshot cards** interleave with bubbles in one chronological stream; a capture card in a thread looks identical to a grid card, just full-width-capped.
- Pinned strip: small horizontal thumbnails above transcript; click scrolls to/opens capture.
- AI answers that cite a capture render a mini-thumbnail reference chip in the bubble.

## Empty states (Requirement — warm, instructive, exactly one action)

| Page | Message direction | Single action |
|---|---|---|
| Dashboard (first run) | "Your visual memory starts with one screenshot." | Show ⌃⇧C / download Mac app |
| Inbox (zero) | "Inbox zero. Everything's filed." | none — collapse |
| Thread (new) | "Ask a question or drop a screenshot to start this thread's memory." | Focus composer |
| Search (no hits) | "Nothing matches yet — here's the closest I have." | Clear filters |
| Settings/deletion | n/a | — |

No illustrations of sad boxes/empty folders. A quiet line of text and one action.

## Onboarding feel (Requirement)

- Target: **under 3 minutes** from sign-in to first captured-and-classified screenshot (measured via PostHog `onboarding_completed`).
- One idea per screen, max 4 screens (sign in → install → permission explainer → first capture live-wait).
- The finale is the product itself doing its trick: user presses ⌃⇧C, the web page shows the capture appear and classify in realtime. That moment is the onboarding.

## AI companion presence (Requirement)

- MVP: AI exists as (a) a **distinct text tone** in chat — direct, observant, slightly wry, consistent — and (b) **suggestion chips**. Nothing else.
- **NO visual mascot/character in MVP.** Post-MVP experiment only. Keep a persona/name slot open in copy architecture (i.e., write AI strings so a name could be prefixed later without rewrites).
- AI never fakes certainty: 0.5–0.8 confidence suggestions phrase as "Looks like {thread}?" with confirm affordance; ≥0.8 auto-assigns with a visible, undoable "Filed to {thread}" note.

## Interaction principles (Requirement)

1. Every AI suggestion dismissible in **one click** — dismiss is never buried in a menu.
2. **Nothing blocks capture.** No modal, sync, error, or update prompt may intercept the capture path (Mac side: see 12_MAC_APP_PLAN.md failure table).
3. **Optimistic UI on confirm/assign/pin** — apply instantly, reconcile in background, undo toast on failure.
4. Keyboard-first triage: Inbox navigable with arrows, Enter = confirm suggestion, backspace = dismiss (idea — adjustable bindings).
5. Motion: 120–200 ms ease-out, opacity/transform only; overlay animations never delay clipboard availability.

## What to avoid (Requirement)

- Dense dashboards, stat walls, "activity" charts.
- Folder trees, nested collections, manual tag-management UI.
- Social features (sharing feeds, likes), gamification (streaks, badges).
- Notification spam — the only pushes ever considered: upload failure (opt-in), weekly digest (email, opt-in).
- Onboarding checklists that outlive onboarding.
- Seven-color category rainbows; decorative AI sparkles on every surface.

## Starter tokens (idea-level — all values adjustable during build)

| Token group | Values |
|---|---|
| Type scale | 12 / 14 (body) / 16 / 20 / 28 / 36 px; Inter or Geist; one family, two weights (400/600) |
| Spacing | 4-px base: 4, 8, 12, 16, 24, 32, 48, 64 |
| Radius | cards 12, chips 999 (pill), inputs 8, overlay panel 16 |
| Accent | one warm accent, e.g. `#E8683A` (terracotta) — placeholder, pick against real screenshots since images dominate the canvas |
| Neutrals | near-white `#FAFAF8` / near-black `#141412` surfaces; hairline borders at 8–12% alpha |
| Shadow | one level only, low-spread, for overlay + hover cards |

Rule of use: tokens are the vocabulary; principles above are the grammar. When a build decision conflicts with a token, keep the principle, change the token.

## Reference board (Mobbin, sourced 2026-07-31)

Requirement: before building any surface listed here, open its references and match the *mechanic*, not the skin. Each row names exactly what to take — and, where it matters, what to leave.

### Library / Inbox grid — `apps/web` home

| Reference | Take | Leave |
|---|---|---|
| [mymind](https://mobbin.com/screens/c539be44-c979-481c-942a-99d5aaa02a92) | Search is the hero: an oversized ghost input ("Search my mind…") sits where a page title would, and there is no folder tree at all. Masonry with mixed card heights. Tag editing happens in a small inline popover **on the card**, never on a separate edit page. | Their tag-entry affordance is manual filing; ours is confirm-a-suggestion |
| [Fabric](https://mobbin.com/screens/afa559f5-1faa-40ea-8a91-cd1e2ed00fb9) | Filter row of plain dropdowns above the grid (`Any kind ▾ / Any tag ▾ / Any creator ▾`) → ours becomes `Any intent ▾ / Any project ▾ / Any date ▾`. Date-group headers between rows. Floating pill toolbar bottom-center for the primary actions. | Multi-type kind filter (screenshots only in v1) |
| [Savee](https://mobbin.com/screens/11d32646-9294-4f5d-bbe1-e5bcad09bda3) | Dark moodboard density: image-first, zero captions until hover, tight gutters. This is the dark-mode target for the grid. | Follower/social counts |

### Inbox triage — the confirm/correct moment

| Reference | Take |
|---|---|
| [Notion Mail](https://mobbin.com/screens/c76eb3bd-f70d-4235-baf4-f24c06421205) | The AI action menu is exactly three verbs — **Accept / Discard / Try again**. Adopt this vocabulary for the overlay chip and Inbox rows: Confirm / Ignore / Reclassify. "Try again" is the cheap escape hatch that stops a wrong suggestion from feeling like a dead end. |
| [Cohere Classify](https://mobbin.com/screens/826e308b-d76d-456f-85dc-38b590ea82ec) | Confidence rendered as a small bar + percentage next to each label. Use in Inbox only, to explain *why* an item landed there (<0.5). Never show confidence on a high-confidence auto-assign — it invites second-guessing. |
| [Asana Inbox](https://mobbin.com/screens/97d38ac9-183b-4602-a52c-eeaa774a5e6a) | A dismissible summary card pinned above the list with its own timeframe selector — the correct home for the weekly digest when it ships (post-MVP), rather than a separate page. |

### Thread view + chat

| Reference | Take |
|---|---|
| [Mistral Le Chat](https://mobbin.com/screens/181ce284-3dcd-4d44-bb1f-368d2e5db997) | Sidebar with a **Projects** section sitting above loose **Chats** — validates our ProjectThread-as-nav model and the Inbox-on-top ordering. |
| [ChatGPT](https://mobbin.com/screens/73833b79-1dd5-4354-8fc4-a2e99c33a75e) | Right-hand rail toggling `Activity | N Sources`, plus inline citation chips inside the answer text. This is how we satisfy the "answer names which screenshots it used" requirement (AC-CHAT-02) without cluttering the prose: chips inline, full list in the rail. |
| [Perplexity](https://mobbin.com/screens/255cd6bc-8136-4a3b-962e-34834e7caede) | Progressive status lines while retrieval runs ("Searching seminal patents…"). Ours: "Searching your memory… 3 screenshots found" while `search_memory` executes — turns latency into visible work. |
| [Google Gemini](https://mobbin.com/screens/bcc65f48-0e66-49d4-b648-0566d26b6c56) | Collapsible "Show thinking" trace with source pills. Use collapsed-by-default for the retrieval trace; calm surface stays calm, debuggability stays available. |
| [ClickUp Brain](https://mobbin.com/screens/8af1437b-71a4-4b50-b7e1-3964b5d19dab) | Fresh-image chat pattern: the image renders as its own bubble and the assistant opens with a description of what it sees, then offers next actions. This is precisely the overlay "Ask AI" entry point (UC1, UX-bug debugging). |
| [Front](https://mobbin.com/screens/a25fd5f3-a74a-4abc-b5f5-11b38cb684fa) | Three-pane layout — list ‖ conversation ‖ context rail — as the thread-view skeleton at desktop widths. |

### Search results

| Reference | Take |
|---|---|
| [Air](https://mobbin.com/screens/5715ed4a-aa84-452b-8883-8ecb9a330731) | Filter chip row directly above the results grid plus a plain result count ("16 ASSETS"). Saved searches live in the sidebar — note as post-MVP, not built. |
| [GoFundMe](https://mobbin.com/screens/ef3070ca-c46f-4859-ab97-0fa76c448552) · [Unity](https://mobbin.com/screens/d009669f-31a0-46ce-b29d-b44645c4a924) | Applied filters echo back as removable pills (`Past 30 days ×`) with a single `Reset`. Required for our date-extraction feature: when the query "pricing page saved in March" auto-applies a date filter, the pill is what makes that visible and reversible. |
| [Pinterest](https://mobbin.com/screens/8f7e7e74-7eb0-4d17-b68d-6d9c7159cf31) | Horizontally scrollable chip row under the search field for one-tap refinement → our seven intents. |

**Anti-pattern noted across references:** every one of these tools eventually grows a filter drawer with a dozen facets. Capso ships three filters (intent, project, date) and adds a fourth only when a real query fails without it — see the tripwire table in `04_MVP_SCOPE.md`.
