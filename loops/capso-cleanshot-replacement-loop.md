---
name: capso-cleanshot-replacement
description: Build and verify one atomic step toward replacing CleanShot X for Elvin's daily screenshot workflow.
schedule: "0 * * * *"
timezone: Asia/Hong_Kong
trigger: Codex heartbeat attached to the current Capso task, or manual continuation
maker_agent: primary-codex-implementer
checker_agent: independent-read-only-reviewer
executor_agent: primary-codex-implementer-after-approval
---

# Loop: Capso CleanShot Daily-Driver Replacement

## Purpose

Move exactly one failing gate in `27_CLEANSHOT_DAILY_DRIVER_PARITY.md` toward PASS per
run, while keeping the branch green and preserving all pre-existing user work. The loop
ends only after the five-day dogfood exit gate passes.

## Pre-conditions

1. Read the root and project `AGENTS.md`, then follow the reading order in
   `20_AGENT_LOOP_INSTRUCTIONS.md`.
2. Read this file, `loops/STATE.md`, and `27_CLEANSHOT_DAILY_DRIVER_PARITY.md` in full.
3. Confirm the branch is `codex/capso-cleanshot-replacement` and record HEAD/status.
4. Compare `git status --short` with STATE's protected pre-existing paths. Preserve them.
   If unrelated tracked edits or new concurrent changes appear, this is a **preflight
   non-run**: report NO-OP in the task output only and stop without acquiring a lease or
   writing any repository file, including STATE, BUILD_LOG, or `.run-log.txt`.
5. Do not run `scripts/sync.sh start` on a dirty tree. Do not stash, reset, clean, move,
   rename, or delete user work.
6. Acquire the canonical lease at `loops/.active-run` before Maker work. Generate a unique
   `RUN_ID`, then atomically run `mkdir loops/.active-run`; success owns the lease. Create
   the metadata directory `loops/.active-run/owner-$RUN_ID-started-$EPOCH` immediately.
   If `loops/.active-run` exists as a regular file or another unexpected type, treat it as
   a foreign/legacy lease: report a no-write NO-OP and never modify or remove it. If the
   atomic `mkdir` fails on a directory, inspect its owner directory and mtime. A lease
   younger than 90 minutes means another run owns the repo: report a no-write NO-OP and
   exit. For a stale directory lease, verify there is no repo-scoped build/test/edit
   process and no Git index lock before removing exactly that stale owner directory and
   `loops/.active-run`, then acquire again. Never remove a live or ambiguous lease.
7. The installed CleanShot app is a black-box reference. Never alter its settings or
   invoke its capture URL schemes from an unattended run.

## Hour budget

- 0–10 minutes: orient, inspect evidence, select one objective.
- 10–40 minutes: implement the smallest coherent change, test-first where applicable.
- 40–50 minutes: self-review and run targeted verification.
- 50–57 minutes: independent Checker review; Maker repairs at most twice.
- 57–60 minutes: approved commit or safe partial handoff, state/log updates, release lease.

If the objective cannot fit, shrink it before editing. Never rush verification to fit the
clock; log a coherent green partial state instead.

## Execution Flow

### Step 1 — Select one objective (Maker)

1. Take the first unblocked item from STATE's ordered queue whose prerequisites pass.
   Manual items may remain BLOCKED while a later independent code item runs, but DOG-01 is
   ineligible until every scoreboard gate is PASS.
2. Inspect the current code before deciding the change; never trust stale checklist status.
3. Write the `20_AGENT_LOOP_INSTRUCTIONS.md` objective block into working notes:
   objective, phase/tasks, allowlisted files, out-of-scope neighbors, observable done-when,
   exact verification commands, and mapped acceptance/gate IDs.
4. One objective may contain one coherent vertical result. Hotkey + overlay + queue + AI is
   not one objective.

### Step 2 — Establish a failing proof (Maker)

- Queue/state/IPC/API/routing logic: add or identify a failing automated test first.
- Native UI/glue that cannot be unit-tested: record a reproducible manual failure plus the
  command or screenshot evidence that will demonstrate the fix.
- Never weaken an assertion, delete a test, or substitute compilation for runtime proof.

### Step 3 — Implement the minimum change (Maker)

- Modify only the objective's allowlisted files.
- Reuse the existing Tauri, React, shared capture, storage, and annotation seams before
  adding dependencies. Explain any new dependency before adding it.
- Keep foreground capture independent from network and AI: persist pixels first, then
  clipboard/overlay, then background work.
- Preserve Capso's visual identity. Match CleanShot's interaction quality and timing, not
  its proprietary appearance or assets.
- Do not push, deploy, publish, alter production, apply migrations, spend money, change
  CleanShot settings, or distribute a build.

### Step 4 — Self-review and verify (Maker)

1. Read the complete objective diff and run `git diff --check`.
2. Run the targeted test, then relevant typecheck/lint/build commands.
3. UI/native behavior requires direct QA and fresh evidence; if the environment cannot
   perform it, mark the gate unverified rather than PASS.
4. Append concise raw command results to ignored `loops/.run-log.txt`; never log secrets.

### Step 5 — Independent review (Checker)

Dispatch a different read-only reviewer agent. It receives the objective block, complete
diff, test output, relevant acceptance criteria, and evidence. It must check:

1. The claimed behavior is implemented, not simulated or browser-dependent unless scoped.
2. Capture pixels cannot be lost on cancellation, failure, offline state, restart, or retry.
3. Focus, clipboard, permission, multi-display, privacy, and performance implications were
   handled or explicitly left outside this objective.
4. Tests prove the new behavior and no required verification was skipped.
5. No unrelated/user files, secrets, proprietary CleanShot assets, production state, or
   scope creep entered the diff.

The Checker returns `APPROVE` or `REJECT` with concrete findings and severity. After the
initial submission, the Maker may make at most **two repair-and-resubmission attempts**.
If the Checker rejects the second retry (the third verdict), log FAILURE and stop. The
Maker never approves its own work.

### Step 6 — Execute approved result (Executor)

Only after Checker APPROVE:

1. Update the matching gate and ordered queue in `loops/STATE.md`.
2. Append the run row to STATE and a full objective/outcome entry to `BUILD_LOG.md`.
3. Update `MASTER_PLAN.md` and `19_BUILD_SEQUENCE.md` only when the objective actually
   changes their status. Locked-scope changes still require owner approval.
4. Stage only the explicit allowlist after reviewing `git diff --cached`.
5. Commit on `codex/capso-cleanshot-replacement` with a lowercase conventional commit.
6. Do not push or merge automatically. Report the commit and current dirty/untracked state.

For an approved partial result, leave a green, compilable tree and log the exact resume
point. Do not commit a partial that does not produce a coherent verified improvement.

### Step 7 — Release lease and report

Release only the lease owned by this run: verify the metadata directory contains this
run's `RUN_ID`, remove that exact owner directory, then `rmdir loops/.active-run`. A run
must never release another run's lease. Update the last-run fields and report:

- objective and gate moved;
- changed files and commit, if any;
- exact tests/evidence;
- Checker verdict and repairs;
- remaining blockers and next objective;
- whether Elvin must perform a manual permission, signing, CleanShot comparison, or
  dogfood action.

## Exit Conditions

### Success

- One objective is Checker-approved, all relevant checks pass, state/docs are updated, and
  the result is committed on the loop branch; or the complete five-day dogfood gate passes.
- When the complete gate passes, mark the persistent goal complete and disable the hourly
  heartbeat. Do not uninstall CleanShot or publish Capso automatically.

### No-op

- Preflight conflict or a foreign/live lease: report externally only; do not acquire a
  lease and do not write STATE, BUILD_LOG, raw logs, or any repository file.
- After this run owns the lease, the next gate may prove to require an explicit human QA
  action or no safe atomic objective may remain. In that case log why and the next wake
  condition, release this run's lease, and make no product-code change.

### Failure

- Tests/build remain red, the Checker rejects the second retry (third verdict), a STOP
  condition is reached after lease acquisition, or the tree cannot be left coherent and
  green. Preserve all work, log the exact failure and smallest owner action, release the
  lease, and stop. Concurrent/unrelated edits detected before ownership use the no-write
  preflight exit above.

## Related Files

- `27_CLEANSHOT_DAILY_DRIVER_PARITY.md`
- `loops/STATE.md`
- `20_AGENT_LOOP_INSTRUCTIONS.md`
- `19_BUILD_SEQUENCE.md`
- `21_ACCEPTANCE_CRITERIA.md`
- `22_TEST_PLAN.md`
- `05_FEATURE_SPEC_CAPTURE.md`
- `12_MAC_APP_PLAN.md`
- `26_CAPTURE_PARITY_AND_MAC_APP.md`
- `specs/permission_model.md`
- `specs/api_contracts.md`
