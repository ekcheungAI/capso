# Deferred log

> Created per the process rule at `04_MVP_SCOPE.md:83`. One line per deferral or rejection, appended
> as it happens. No design discussion here — link to the doc that holds the reasoning.

## 2026-08-01 — market evidence review (`25_MARKET_AND_COMPETITIVE_RESEARCH.md`)

Source inputs: [r/PKMS screenshot-organizer thread](https://www.reddit.com/r/PKMS/comments/1klkvrl/looking_for_a_nice_screenshot_organizer_picojar/)
and an owner-supplied (simulated) persona doc. Evidence-quality caveats: 25 §0.

**Deferred to `04_MVP_SCOPE.md` Table 2** — `source_url` as classifier signal · session/flow grouping ·
`has_pending_action` resurface ranking · multi-project membership · public changelog.

**Rejected** (reasoning: 25 §5):

- iOS / mobile capture app — already deferred at `04:49`; this thread is **not** the trigger, the OP is not customer zero.
- Auto-delete originals after filing — camera-roll hygiene, fails the litmus test; destructive by default.
- Batch-import the screenshot backlog — tripwire `04:77`; backlog paralysis is real, resurfacing is the fix.
- Tags/folders alongside projects — stays rejected, `04:72`.
- Push to Linear/Jira, snippet export to dev tools — violates the "not a dev-only screenshot pipe" non-goal, `01:74`.
- Contextual recall inside Notion/Figma — different product; revisit post-PMF only.
- Pattern decks / incident episodes as new surfaces — these are project threads (M6) relabelled.
- Metric-aware structured search ("RPM > X") — speculative; needs real dashboard-capture data first.

**Raised and left open** — local-first as a *stated* position rather than an implementation detail
(25 §2.6, §6). Owner decision; would change `01`'s non-goals and constrain `19` P0/P1 auth work.

**Ordering constraint recorded, not a deferral** — no new AI feature before capture-to-storage is
reliable (25 §2.3). Extension has never been loaded in a real Chrome; `/api/ingest` drops captures.
