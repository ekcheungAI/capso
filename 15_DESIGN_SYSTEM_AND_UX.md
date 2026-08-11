# 15 — Design System & UX (Capso)

> Product name "Capso" is a working name, unconfirmed — treat as an assumption.
> Scope: shared design language for the web app (13_WEB_APP_PLAN.md) and the Mac overlay/menus (12_MAC_APP_PLAN.md). Benchmark: mymind.com — borrow calm, beauty, privacy-feel, zero-folder ethos. **Borrow qualities, don't clone** (Requirement).

## Assumptions

- One user (Elvin), one taste. Optimize for his daily comfort, not broad-market neutrality.
- Web is the primary design surface; Mac overlay inherits the same tokens at smaller scale.
- Tailwind + shadcn-style primitives as implementation substrate (idea — swap if the build agent prefers, but keep the tokens).

## Out of scope

- Marketing site design.
- ~~Mascot/character design (explicitly post-MVP — see AI presence below).~~ *(Amended 2026-08-01: this is no longer deferred, it is decided against — see AI presence below. Leaving it as "post-MVP" implied a character was still coming.)* *(Amended 2026-08-12: **character** stays decided against; **illustration** does not. Capso now ships a generated visual language — see "Generated art" below. The two were conflated in the 2026-08-01 write-up, and separating them is the whole of this amendment.)*
- Full a11y audit (baseline only in MVP: contrast, focus rings, keyboard nav for triage/search).

## Design principles (Requirement)

1. **Calm over busy.** Fewer elements per screen than feels safe. If a screen has two competing focal points, cut one.
2. **Memory, not filing.** No folders to create, no tag managers, no taxonomy chores. The user captures and confirms; the system organizes. *(Amended 2026-08-01: the library groups captures into per-project **shelves** by default. This is a read-only view of project threads the system already maintains — the user still never builds or maintains a hierarchy. What is banned is filing **work**, not the visible evidence that filing happened.)*
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
- ~~**Single accent color** used only for: primary actions, active states, AI suggestion chips.~~ *(Reversed 2026-08-01, recorded rather than deleted. This line contradicted the token table below it, which resolved to `Accent | **None.**` — see the terracotta rationale under Tokens. Buttons are ink; links are underlined, not coloured; the only hue in the product is the intent dot and the captures themselves. Provenance is carried by the mark and the dashed card edge, not by colour.)* Everything else neutral.
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
- Intent chips: 7-value taxonomy (design_inspiration, ux_bug, competitor, marketing_hook, content_idea, reference, other). ~~chip color = tinted neutral, not 7 rainbow colors~~ *(Amended 2026-08-01. The instinct was right, the implementation was not: seven identical grey chips meant the taxonomy the product computes was invisible. What shipped is the narrow version of the same idea — **the chip stays neutral and carries an 8px coloured dot**. Six mid-tone, low-chroma hues in `INTENT_COLOR`, tuned to clear 3:1 on both grounds; `other` has no colour because it is the absence of a classification, not a seventh category. This is the only hue in the product besides the captures.)*

## Thread patterns (Requirement)

- Chat bubbles: user right-aligned, ~~accent-tinted~~ *tinted with the ink token at low alpha (there is no accent hue to tint with)*; AI left-aligned neutral, no avatar image in MVP (see AI presence). The AI side is identified by the mark, per the provenance rule — not by a bubble colour.
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

~~No illustrations of sad boxes/empty folders. A quiet line of text and one action.~~

*(Amended 2026-08-12 — owner decision.)* Empty states carry generated art (see "Generated art"). The half of this rule that survives is the **subject**: still no sad boxes, no crossed-out folders, no shrugging ghosts. An empty slot in Capso means **ready**, not **failed** — a tray with room in it, not a bin with nothing in it. The single-action rule is unchanged: one action, still one line of copy.

## Onboarding feel (Requirement)

- Target: **under 3 minutes** from sign-in to first captured-and-classified screenshot (measured via PostHog `onboarding_completed`).
- One idea per screen, max 4 screens (sign in → install → permission explainer → first capture live-wait).
- **Starter-kit screen (added 2026-08-01).** Before the first capture, one screen asks what kind of work the user screenshots for and creates that role's projects (03 §starter kits). No sidebar, no search bar and no capture button compete with it. Each card lists the projects it would create, so the choice is legible rather than blind. Skippable via "Start empty"; never shown again.
- The finale is the product itself doing its trick: user presses ⌃⇧C, the web page shows the capture appear and classify in realtime. That moment is the onboarding.

## AI companion presence (Requirement)

- MVP: AI exists as (a) a **distinct text tone** in chat — direct, observant, slightly wry, consistent — and (b) **suggestion chips**. Nothing else.
- **NO visual mascot/character. Settled 2026-08-01, no longer "post-MVP experiment".** The identity work closed this rather than deferring it, on evidence: every reference image supplied for the brand contains objects in order and zero characters, and a Mobbin sweep found almost no product shipping a mascot inside a *working* interface — they live on login, loading and thank-you screens. A character would also fight the one thing the product must be, which is trustworthy with your filing. Keep the persona/name slot open in copy architecture as before. *(Reaffirmed 2026-08-12. The illustration ban was lifted; this one was not. Note what the evidence above actually says — "objects in order and zero characters" is not an argument against imagery, it is an **art direction**, and it is now the brief the generated art is held to. See "Generated art".)*
- **The mark carries AI presence instead.** Four states — at rest / reading / suggesting / filed — mapping one-to-one onto `apps/web/components/capture.tsx:268-275`, plus the provenance rule: **the mark means Capso decided, its absence means you did**, and confirming a suggestion takes it off. Full spec in `drafts/brand/GUIDELINES.html`.
- **A minimal face was drawn and declined (2026-08-01).** Two square apertures in the foil, tested down to 16px — see `drafts/brand/board-coffee.html`. They survive the size but read as *damage to the lid* rather than as expression. The mark stays an object. This would only reopen if Capso needed to be liked before it is trusted (an acquisition problem), and the answer then would be a properly illustrated character, not this.
- **The coffee metaphor is carried by motion and vocabulary, not ornament.** The seat and the crimp (see Motion) are the feeling; the lexicon — *rack, slot, seat, pull, lid, crimp* — is the language. Rule: **never explain the metaphor in the UI.** "Seated in Pricing page redesign" has to work for a reader who never thinks about coffee. *(Narrowed 2026-08-12: the metaphor may now also be carried by **imagery** — generated art depicts capsules, decks and trays directly. The in-UI rule is untouched and is the reason this is a narrowing rather than a reversal: the art shows the object, and no caption beside it ever names the metaphor.)*
- AI never fakes certainty: 0.5–0.8 confidence suggestions phrase as "Looks like {thread}?" with confirm affordance; ≥0.8 auto-assigns with a visible, undoable "Filed to {thread}" note.
- **Resurfaced captures state their reason.** A capture Capso brings back carries one muted line saying why. A recommendation the user cannot interrogate is one they can neither trust nor dismiss.

## Generated art (Requirement — decided 2026-08-12)

Capso ships a generated visual language. This reverses the illustration ban of 2026-08-01; it does **not** reverse the character ban, which is reaffirmed above.

- **Direction: "Decks and Trays."** Editorial still-life photography of the objects the product is already named after — brushed anodised aluminium capsule lids with a shallow crimped rim and one notched edge, arranged in **decks** (stacked, offset like a dealt hand) and **trays** (low sand paperboard racks with evenly spaced circular slots, some seated, some empty and waiting).
- **Treatment.** 80mm at f/5.6, one soft window from upper left, no fill. Matte throughout — paper, not plastic. Long soft-edged warm-grey shadows, consistently lower-right. Asymmetric, with negative space left for type.
- **Palette.** Warm neutral only, reusing `marketing.*`: clay, sand, espresso, aluminium grey. Chroma ceilings live in `tokens.json` under `illustration` and are **asserted**, not eyeballed — see principle 5.
- **Never.** No people, faces, hands, characters, eyes. No glow, neon, bloom, flare, particles, sparkles. No blue-purple tech gradient. No circuit boards, brains, robots, wireframe globes. No floating 3D UI panels, glassmorphism, chrome. No 3D-render look. No readable text or logos. No stock desk clutter. Never centred with a radial glow.
- **An empty slot means ready, not failed.** The one piece of the old empty-state rule that survives intact.
- **Sample screenshots are a separate class** and are deliberately **off-brand**: they depict fictional third-party products (Verrick, Brellow, Palewick, Corveth, Skaldi, Weftly), so `build_art.py` checks them the opposite way round: a sample must carry a brand colour **of its own**. Capso has no accent by decision, so "has a hue" is what distinguishes somebody else's product from ours. A sample that looks like Capso is a bug. They must never depict a real product — see `apps/web/lib/store/seed.ts`.
- **Provenance.** Every shipped asset is recorded in `drafts/brand/art/manifest.json` with its prompt, model, job id and credit cost. Raw output stays gitignored under `drafts/brand/renders-art/`; curated masters are committed under `drafts/brand/art/approved/`.

## Interaction principles (Requirement)

1. Every AI suggestion dismissible in **one click** — dismiss is never buried in a menu.
2. **Nothing blocks capture.** No modal, sync, error, or update prompt may intercept the capture path (Mac side: see 12_MAC_APP_PLAN.md failure table).
3. **Optimistic UI on confirm/assign/pin** — apply instantly, reconcile in background, undo toast on failure.
4. Keyboard-first triage: Inbox navigable with arrows, Enter = confirm suggestion, backspace = dismiss (idea — adjustable bindings).
5. Motion: 120–200 ms ease-out, opacity/transform only; overlay animations never delay clipboard availability.
6. **The seat (added 2026-08-01).** Confirming a suggestion plays `capso-seat` + `capso-crimp` (`globals.css`) — a 220 ms dip-and-return with **zero overshoot**, plus one ring tighten. The material decides the curve: a capsule is aluminium into a socket, so it decelerates hard and stops dead. A bounce would read as rubber and would break rule 5's spirit. The commit stays optimistic — the motion runs alongside the state change, never gating it.

## What to avoid (Requirement)

- Dense dashboards, stat walls, "activity" charts.
- Folder **trees**, nested collections, manual tag-management UI. (Flat project shelves in the library are fine — one level, system-maintained, no nesting ever.)
- Social features (sharing feeds, likes), gamification (streaks, badges).
- Notification spam — the only pushes ever considered: upload failure (opt-in), weekly digest (email, opt-in).
- Onboarding checklists that outlive onboarding.
- Seven-color category rainbows *(the six intent **dots** are the permitted exception and the boundary is exact: 8px, semantic, never applied to text or a card surface)*; decorative AI sparkles on every surface — the mark is the AI signal, and it is never decoration. *(Reaffirmed 2026-08-12 — unchanged by the illustration decision, and load-bearing because of it. Art is now permitted; **decoration** still is not, and "the mark is the AI signal" still holds. Generated art may never depict an AI, a sparkle, a glow, or a face.)*
- **Art that out-saturates a capture.** Generated art is warm-neutral and low-chroma by construction, and `drafts/brand/art/build_art.py` asserts it. Principle 5 — screenshots are the hero — was not repealed on 2026-08-12; it is the reason the art has a chroma ceiling instead of a free hand.

## Tokens (decided 2026-08-01)

**Canonical source: `packages/shared/src/tokens.json`. Nothing else in the repo may declare a colour.** The values below are documentation of that file, not a second copy of it — when the two disagree, the JSON wins and this table is the bug.

| Token group | Values |
|---|---|
| Type scale | 12 / 14 (body) / 16 / 20 / 28 px; system sans, no webfont in the app; two weights (400/600) |
| Spacing | 4-px base: 4, 8, 12, 16, 24, 32, 48, 64 |
| Radius | cards 12, chips 999 (pill), inputs 8, overlay panel 16 |
| Accent | **None.** Buttons are ink `#1F1F1E` on bone, inverted in dark mode |
| Neutrals | bone `#F4F0EB` ground / surface `#FAF8F4` / ink `#1F1F1E` / muted `#6F6A62`; hairlines at 10% alpha |
| Danger | light `#933A4E` / dark `#D4808F` — a **pair**, because no single red clears 4.5:1 on both grounds |
| Intent | six mid-tone hues in `INTENT_COLOR`, shown as 8px dots only, never as text |
| Marketing | clay `#EBDBCC` ground, espresso `#311B0F` type, Fraunces 600 (SIL OFL 1.1) — marketing surfaces only |
| Illustration | *(added 2026-08-12)* No new hues — reuses the marketing values as `ground` / `ground-alt` / `ink`. The new values are three **assertable ceilings**: `maxChroma`, `maxMeanChroma`, `groundDeltaE`. Raster cannot be tokenised, so these are a contract `build_art.py` checks, not CSS |
| Shadow | one level only, low-spread, for overlay + hover cards |

**The terracotta placeholder was retired, not tuned.** It failed AA twice over — `#E8683A` measured 3.10:1 as text on the old ground and 3.24:1 under white, and no single terracotta cleared AA on both light and dark, so it needed a hand-tuned pair per mode. More fundamentally, the note above it was right: images dominate the canvas, and any brand hue competes with arbitrary captured pixels and loses. Measured on a full grid of real captures, **100% of the chromatic pixels on screen belong to the screenshots**. Removing the accent also removes the mode-dependence, because ink simply inverts with the theme.

The ground is warm for a functional reason, not a stylistic one: most captures are white-ish, so bone has to separate from pure white or cards stop having edges. Bone measures 1.135:1 against white; a cool near-white manages 1.073:1 and the grid reads as one sheet.

Consequence for links: with the accent equal to the foreground, colour can no longer mark a link. **Links are underlined, not coloured.** Controls sitting on `text-muted` may still rise to ink on hover.

### How the tokens reach each surface (Requirement)

`pnpm brand:tokens` compiles the JSON into every consumer; `pnpm brand:check` fails the build if any of them is stale **or if any source file declares a colour of its own**, and it runs as part of `pnpm lint`.

| Surface | Consumes |
|---|---|
| `apps/web` | `app/tokens.generated.css`, imported by `app/globals.css` |
| `apps/extension` | `tokens.generated.css`, linked from `popup.html` and `options.html` |
| `apps/mac` | `src/tokens.generated.css`, imported by `src/App.css` |
| `drafts/brand/mark` | `tokens.generated.json`, read by `build_icons.py` and `build_og.py` |
| `drafts/brand/art` | `tokens.generated.json`, read by `build_art.py` for the illustration ceilings *(added 2026-08-12)* |

This exists because the alternative was already failing. Before it, the palette was hand-copied into six places and three had drifted: the extension options page still carried a retired accent pair, the extension popup carried the accent before *that* plus the OS system colours, and the Mac popover declared no brand values at all. Nobody made a mistake — there was no mechanism, so drift was the default.

One escape hatch, `brand-allow: <reason>`, with a mandatory written reason. It exists for exactly one legitimate case: content that depicts **somebody else's** product. The sample screenshots must not use Capso's palette, because a fake screenshot of another site that looks like Capso is worse than no sample at all.

*(Amended 2026-08-12: the sample screenshots stopped being drawn to a canvas in `capture.tsx` and became generated WebP files, which `brand:check` does not scan at all. The rule did not weaken — it got **stronger**, because the check moved from a comment to an assertion: `build_art.py` fails any sample that has no palette of its own. Note a distance-from-bone test was tried first and rejected — a realistic light SaaS UI measures only ΔE 2.9 from bone, so that gate would have forced every sample dark or heavily tinted, and an unbelievable sample is worse than no sample. The `brand-allow` mechanism stays for the remaining inline cases.)*

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
