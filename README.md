# Capso Planning Pack

This folder is a complete, agent-executable planning system for **Capso** — a Mac + Web screenshot-first AI memory tool (working name, unconfirmed). It was produced from the upstream concept document (`~/Downloads/AI_Capture_Tool_Concept (2).md`, 2026-07-31) plus a structured owner interview, and it is the source of truth for what gets built, in what order, and how "done" is judged.

**This pack contains no application code.** Code lives in the repos the build loops create; these docs govern them.

## What's in here

- `MASTER_PLAN.md` — canonical entry point: product summary, decision log, assumptions, open questions, status ledger, next action. **Always read this first.**
- `01`–`04` — product core: brief, problems/JTBD, personas, and `04_MVP_SCOPE.md`, the scope authority every feature request is tested against.
- `05`–`08` — feature specs: capture, AI memory, project threads, search/retrieval.
- `09`–`14` — system: AI model routing and cost control (`09`), data model (`10`), architecture and tradeoffs (`11`), Mac app plan (`12`), web app plan (`13`), backend/storage (`14`).
- `15`–`18` — design system/UX, pricing (documented, not built), metrics, risks and open questions.
- `19`–`23` — execution: build phases with entry/done criteria (`19`), the binding agent loop contract (`20`), acceptance criteria (`21`), test plan (`22`), external-tester launch checklist (`23`).
- `specs/` — deep specs implementation agents consume directly: user flows, edge cases, API contracts, analytics event schema, permission/privacy model.
- `prompts/` — four reusable prompts that put a coding agent (Claude Code / Fable 5) into a distinct mode: discovery, architecture, MVP build loop, review.

## How an agent should use this pack

1. **Orient**: read `MASTER_PLAN.md` (status ledger + decision log), then `04_MVP_SCOPE.md`.
2. **Pick the mode** and load the matching prompt from `prompts/`:
   - unclear requirement or new idea → `FABLE5_DISCOVERY_PROMPT.md`
   - technical design needed before coding → `FABLE5_ARCHITECTURE_PROMPT.md`
   - implementing → `FABLE5_MVP_BUILD_PROMPT.md` (governed by `20_AGENT_LOOP_INSTRUCTIONS.md`)
   - phase finished / pre-merge → `FABLE5_REVIEW_PROMPT.md`
3. **Execute one loop** with a single verifiable objective from the current phase in `19_BUILD_SEQUENCE.md`.
4. **Verify before claiming done** — commands and thresholds in `22_TEST_PLAN.md`, criteria IDs in `21_ACCEPTANCE_CRITERIA.md`.
5. **Update docs in the same loop**: tick phase checkboxes in `19`, append to `BUILD_LOG.md` (created at P0), refresh the `MASTER_PLAN.md` status ledger.

## Order of execution

```
discovery → plan (this pack) → architecture (per phase, as needed) → MVP build loops (P0…P7)
→ QA/review gates per phase → dogfood gate (owner cancels CleanShot X) → iterate → external testers (23)
```

## Ground rules (bind all agents)

- The MVP litmus test: **if it doesn't serve screenshot → AI → memory → retrieval, it's out** (`04_MVP_SCOPE.md`).
- Requirements vs ideas are marked in every doc; only requirements bind.
- Schema changes require updating `10_DATA_MODEL.md` in the same loop. Same for any architecture deviation (`11`).
- Never publish, send, sign up for paid services, or spend without explicit owner approval. Secrets live in `.env.local`, never in git.
- Stop-and-ask triggers are defined in `20_AGENT_LOOP_INSTRUCTIONS.md`; when in doubt, stop and ask.
