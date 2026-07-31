# 20 — Agent Loop Instructions

Operating manual for implementation agents (Claude Code) building Capso. This document is the contract. If an instruction here conflicts with an agent's default behavior, this document wins. If it conflicts with the owner's live instruction in chat, the owner wins.

## Assumptions

- Agents run in loops: one loop = one session (or one focused stretch) producing one verifiable outcome.
- The repo is the Capso monorepo; the planning pack (this doc set) lives alongside it and is readable every loop.
- Owner = Elvin. "Ask the owner" means stop and present the question in chat; never assume consent.

## Out of scope

This doc does not define WHAT to build (see `19_BUILD_SEQUENCE.md`) or how to test (see `22_TEST_PLAN.md`). It defines HOW a loop operates.

---

## 1. One-loop objective format

Every loop starts by writing this block (into the loop's working notes and later into BUILD_LOG.md). No code before the block exists.

```
## Loop NN — <short title>
Objective: <single verifiable outcome, one sentence>
Phase/tasks: <phase ID + checkbox item(s) from 19_BUILD_SEQUENCE.md — max one task cluster>
In-scope files: <paths or globs the loop may create/modify>
Out of scope: <explicitly named adjacent work this loop will NOT touch>
Done-when: <observable condition(s), mapped to AC IDs from 21 where applicable>
Verification: <exact commands: pnpm typecheck, pnpm test <pattern>, curl, manual step>
```

Rules:
- **One verifiable outcome per loop.** If the objective contains "and" joining two deliverables, split into two loops.
- Scope ≤ one task cluster from the current phase in `19_BUILD_SEQUENCE.md`. Never pull tasks from a future phase.
- "Done-when" must be checkable by command or direct observation — never "code is written".

## 2. Mandatory reading order at loop start

Read, in order, every loop — skim what is unchanged, but confirm it is unchanged:

1. `MASTER_PLAN.md` — current status section: where are we, what changed last loop.
2. `04_MVP_SCOPE.md` — scope litmus test; refresh what is out.
3. `19_BUILD_SEQUENCE.md` — current phase: entry criteria, tasks, done criteria, do-not-build line.
4. The relevant feature doc for this loop's task (the numbered doc covering the feature).
5. The relevant `specs/` file (`user_flows.md`, `edge_cases.md`, `api_contracts.md`, `event_schema.md`, or `permission_model.md`).

Skipping this order and later discovering the answer was in a doc counts as a loop failure.

## 3. Implementation rules

1. **Scope litmus test.** Before building anything not verbatim in the current phase task list, run the `04_MVP_SCOPE.md` litmus test. Fails or ambiguous → STOP rule 1 applies.
2. **No new dependencies without checking existing.** Before `pnpm add`, verify the workspace (including `packages/shared` and existing deps) cannot already do it. New dep → justify in one line in the commit body. Heavyweight deps (>1 MB installed, native modules, anything with postinstall scripts) → ask the owner first.
3. **No schema drift.** The database schema and `10_DATA_MODEL.md` move together. Any migration that changes tables/columns/indexes MUST update `10_DATA_MODEL.md` in the same loop, same commit series. A migration without the doc update is an incomplete loop.
4. **TDD where testable.** For queue logic, ranking, context assembly, correction selection, API routes, and anything listed in `22_TEST_PLAN.md` unit/integration groups: write the failing test first. UI layout and native shell glue are exempt from test-first but not from verification.
5. **Conventional commits.** `feat(scope): …`, `fix(scope): …`, `chore:`, `test:`, `docs:`. Scope = workspace (`mac`, `web`, `db`, `shared`, `worker`). Small commits; each compiles.
6. **Secrets.** Never commit secrets. All keys in `.env.local` (gitignored) with `.env.example` kept current. If a secret ever lands in a diff, stop and tell the owner — do not silently amend.
7. **Contracts are shared.** API request/response shapes live as zod schemas in `packages/shared` and must match `specs/api_contracts.md`. Divergence → update the spec in the same loop or stop.

## 4. Review gates (in order, every loop)

1. **Self-review the diff.** Read the full `git diff` as a reviewer: dead code, debug logs, TODOs without an issue, scope creep, accidental file churn. Fix before proceeding.
2. **Run verification commands** from the loop block: `pnpm typecheck`, `pnpm lint`, `pnpm test` (relevant scope), and `pnpm build` for touched apps. All green or the loop is not done.
3. **Visual QA for UI loops.** Any loop touching UI: run the app, exercise the change, capture screenshot evidence (light + dark if styling changed). "It compiles" is not visual QA.
4. **Then present.** Report: objective, what changed, verification output (actual command output, not "tests pass"), screenshots if UI, deviations from plan, and the doc updates made.

Never claim done without step 2 output in hand (see `verification-before-completion` discipline).

## 5. Testing before merge

- Loop work happens on a branch; merge to main only with CI green.
- Tests required per `22_TEST_PLAN.md` for the touched area must exist and pass before merge — a feature loop that leaves its test group red is not mergeable.
- If a loop's change invalidates the golden eval set or golden queries (`22_TEST_PLAN.md`), rerun the eval in the same loop.

## 6. Doc updates after each loop (mandatory, same loop)

1. Tick completed checkboxes in `19_BUILD_SEQUENCE.md`. Partial tasks stay unticked with a `<!-- partial: … -->` note.
2. Append an entry to `BUILD_LOG.md` (create at repo root if absent): date, loop number, objective block, outcome (done/partial/failed), verification evidence summary, deviations, next-loop suggestion.
3. Update `MASTER_PLAN.md` "current status" section: current phase, last completed loop, known blockers.

A loop that ships code but skips these three updates is incomplete.

## 7. STOP and ask the owner

Stop — write up the question with options and a recommendation, then wait — when ANY of these hold:

| # | Trigger |
|---|---|
| 1 | A scope question fails or is ambiguous under the `04_MVP_SCOPE.md` litmus test |
| 2 | A destructive migration (drop/alter losing data, truncate, irreversible backfill) on any shared or production database |
| 3 | Any external service signup, new account, or granting OAuth access |
| 4 | Any spend or plan upgrade > **$20** one-off or ANY new recurring charge (API tiers, Supabase/Vercel plan changes) |
| 5 | macOS permission-model, code-signing, notarization, or entitlement decisions (incl. adopting the Electron fallback) |
| 6 | Anything that would publish, schedule, upload, send, or DM externally — hard rule per ekOS publishing safety; also mv/rename/rm of project folders |
| 7 | Deleting user-captured data outside the tested deletion flow |
| 8 | The loop wants to change THIS document, `04_MVP_SCOPE.md`, or locked decisions in MASTER_PLAN.md |

Stopping is success, not failure. Guessing through a stop trigger is the failure.

## 8. Loop failure protocol

- **Two failed attempts at the same error** (same test failure, same build error, same runtime bug) → stop attempting. Write findings: what was tried, exact error output, current hypothesis, what you would try third and why it is risky/uncertain. Append to BUILD_LOG.md as `outcome: failed`, then ask the owner.
- Never "fix" a failure by deleting the test, loosening the assertion, skipping CI, or catching-and-ignoring the error.
- If a failure reveals a plan defect (wrong assumption in a pack doc), say so explicitly and propose the doc change — do not silently code around the plan.
- A failed loop leaves the branch pushed and the working tree clean; the next loop starts from the reading order in §2, not from the wreckage.

## 9. Session hygiene

- One loop, one branch, one BUILD_LOG entry. Do not batch three loops into one mega-report.
- Leave main releasable at all times.
- If context runs long mid-loop, land the smallest coherent green state, log it as partial, and hand off via BUILD_LOG.md — never hand off an uncompiling tree.
