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
