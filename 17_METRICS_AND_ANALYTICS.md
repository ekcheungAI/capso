# 17 — Metrics & Analytics

> Instrumentation: PostHog (product events) + Sentry (errors). All events below use the **canonical event names** from `specs/event_schema.md` — no ad-hoc names. Requirement: events are instrumented from day 1 of the MVP build, even with n=1.

## Personal-use phase note (requirement)

During the dogfood phase the sample size is one (Elvin). These metrics still matter: **they validate the loop, not marketing.** With n=1, targets are read as "did the loop work this week for the one user who must love it," and they gate external testers (see `23_LAUNCH_CHECKLIST.md` exit criteria). Do not skip instrumentation "because it's just me" — retrofitting events destroys baselines.

## Metric tree

```
North star: successful retrievals of old screenshots per week
├── Activation      (did the loop start?)
├── Habit/Retention (does capture replace CleanShot X?)
├── AI quality      (does classification earn trust?)
├── Retrieval       (does memory pay off?)
├── Thread health   (is knowledge organized or rotting in Inbox?)
└── Paid conversion (SaaS phase placeholders)
```

### 1. Activation

| Metric | Definition | Source events | Target | Cadence |
|---|---|---|---|---|
| Time to first capture | Install → first `capture_completed` | `capture_completed` (first per user) | < 10 min from install | Per new user |
| Day-1 suggestion confirm | User accepts ≥1 AI suggestion on install day | `ai_suggestion_accepted` (day 0) | ≥ 1 on day 1 | Per new user |
| Onboarding completion rate | Users firing `onboarding_completed` / installs | `onboarding_completed` | ≥ 80% | Weekly (tester phase) |

### 2. Habit / Retention

| Metric | Definition | Source events | Target | Cadence |
|---|---|---|---|---|
| Captures per day | Median daily `capture_completed` on active days | `capture_completed` | ≥ 10/day (owner baseline vs CleanShot usage) | Weekly |
| D7 capture retention | % of users with ≥1 `capture_completed` on day 7 | `capture_completed` | ≥ 60% (tester phase) | Weekly |
| D30 capture retention | Same, day 30 | `capture_completed` | ≥ 40% (tester phase) | Monthly |
| Weekly active capture days | Days per week with ≥1 capture | `capture_completed` | ≥ 5/7 (dogfood) | Weekly |
| Capture failure rate | `capture_failed` / (`capture_completed` + `capture_failed`) | `capture_started`, `capture_completed`, `capture_failed` | < 1% | Weekly + Sentry alert |
| Upload reliability | `upload_failed` / (`upload_succeeded` + `upload_failed`) | `upload_succeeded`, `upload_failed` | < 2% | Weekly |
| Annotation usage | % captures with `annotation_used` | `annotation_used`, `capture_completed` | Track only (parity signal vs CleanShot) | Monthly |

### 3. AI quality

| Metric | Definition | Source events | Target | Cadence |
|---|---|---|---|---|
| **Suggestion acceptance rate** | `accepted / (accepted + corrected + ignored)` | `ai_suggestion_accepted`, `ai_suggestion_corrected`, `ai_suggestion_ignored` | **≥ 60% by week 4 of personal use** (gates external testers) | Weekly |
| Correction rate trend | `corrected / shown`, week over week | `ai_suggestion_corrected`, `ai_suggestion_shown` | Monotonic downward trend (few-shot context working — locked decision #7) | Weekly |
| Suggestion latency | `capture_completed` → `ai_suggestion_shown` | `ai_processing_completed`, `ai_suggestion_shown` | p50 ≤ 5s, p95 ≤ 10s | Weekly |
| Ignore rate | `ignored / shown` (silent → Inbox) | `ai_suggestion_ignored`, `ai_suggestion_shown` | < 25% | Weekly |

### 4. Retrieval success

| Metric | Definition | Source events | Target | Cadence |
|---|---|---|---|---|
| **Search click-through** | Sessions with `search_result_clicked` / `search_performed` | `search_performed`, `search_result_clicked` | **≥ 70% of searches get a click** | Weekly |
| Chat retrieval satisfaction (proxy) | Screenshot referenced in chat then revisited within 24h | `chat_message_sent`, `chat_screenshot_referenced`, `screenshot_revisited` | ≥ 50% of referenced screenshots revisited | Weekly |
| Time-to-value | Install → first successful retrieval of a screenshot ≥ 3 days old (`search_result_clicked` or `screenshot_revisited` on old item) | `search_result_clicked`, `screenshot_revisited` | ≤ 7 days from install | Per new user |
| Old-screenshot find moments | Weekly count of retrievals where target is > 7 days old | `search_result_clicked`, `screenshot_revisited` | ≥ 1/week (dogfood exit criterion, `23_LAUNCH_CHECKLIST.md`) | Weekly |
| Chat engagement | `chat_message_sent` per active week | `chat_message_sent` | Track; informs Free tier N (see `16_PRICING_AND_PACKAGING.md`) | Weekly |
| Deletion rate | `screenshot_deleted` / `capture_completed` | `screenshot_deleted`, `capture_completed` | Track only (high rate = capture junk or trust issue) | Monthly |

### 5. Thread health

| Metric | Definition | Source events | Target | Cadence |
|---|---|---|---|---|
| Threads created/week | Count of `thread_created` | `thread_created` | Track (expect 1–3/week steady state) | Weekly |
| Thread confirmation | `thread_confirmed` / `thread_created` | `thread_created`, `thread_confirmed` | ≥ 80% | Weekly |
| % captures in threads vs Inbox | Captures with accepted/corrected suggestion / all captures | `ai_suggestion_accepted`, `ai_suggestion_corrected`, `capture_completed` | ≥ 70% in threads (Inbox = graveyard tripwire in `18_RISKS_AND_OPEN_QUESTIONS.md`) | Weekly |
| Digest engagement | `digest_viewed` / `digest_generated` | `digest_generated`, `digest_viewed` | ≥ 75% viewed | Weekly |

### 6. Paid conversion (SaaS phase — placeholders, not active)

| Metric | Definition | Source events | Target | Cadence |
|---|---|---|---|---|
| Free → Pro conversion | Paying / free actives (30d) | Stripe + PostHog identify (Phase 3, `16_PRICING_AND_PACKAGING.md`) | Placeholder ≥ 5% | Monthly |
| Chat-cap hit rate | Free users hitting 50-msg cap | `chat_message_sent` (count ≥ 50/mo) | Track; primary upgrade trigger | Monthly |
| History-wall hit rate | Searches attempting > 30-day window | `search_performed` (property: `history_gated=true`) | Track; secondary upgrade trigger | Monthly |
| Churn | Cancelled / paying | Stripe | Placeholder < 5%/mo | Monthly |

## PostHog dashboards to create

1. **Daily Loop (dogfood):** captures/day, capture+upload failure rates, suggestion latency p50/p95, acceptance rate, searches + CTR. Checked daily during dogfood.
2. **AI Quality:** acceptance/correction/ignore trends, latency, % captures in threads. Weekly review; feeds the ≥60% tester gate.
3. **Retrieval & Value:** search CTR, old-screenshot finds/week, time-to-value funnel (install → first capture → first accepted suggestion → first old retrieval), chat volume vs Free cap.
4. **Reliability:** `capture_failed`, `upload_failed`, `ai_processing_completed` latency; paired with Sentry issues.
5. **(Tester phase) Activation funnel:** install → `onboarding_completed` → first `capture_completed` → day-1 `ai_suggestion_accepted` → D7 retention.

Alerts (PostHog/Sentry): capture failure > 2% daily; suggestion latency p95 > 10s; upload failure > 5% — same-day investigation.

## Review cadence

- **Daily (dogfood, 2 min):** Dashboard 1 glance.
- **Weekly (Friday review):** Dashboards 2–3; log acceptance rate + old-finds count against tester-gate criteria.
- **Monthly:** retention, deletion rate, cost-per-user actuals vs `16_PRICING_AND_PACKAGING.md` assumptions.

## Assumptions

- All targets except the two bolded requirements (acceptance ≥60% wk4; search CTR ≥70%) are initial guesses — recalibrate after 4 weeks of data.
- `search_performed` carries a `history_gated` property (add to `specs/event_schema.md` if missing).
- PostHog free tier suffices for n=1 → small tester cohort.

## Out of scope

- Marketing/acquisition analytics (traffic, CAC) — no public launch in this doc's horizon.
- A/B testing infrastructure.
- Revenue dashboards (Phase 3, with Stripe).
