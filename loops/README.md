# Capso Loops

Project-local autonomous loops live here. They follow `20_AGENT_LOOP_INSTRUCTIONS.md`
and the ekOS Maker–Checker contract.

| Loop | Trigger | Purpose |
|---|---|---|
| `capso-cleanshot-replacement-loop.md` | Hourly Codex heartbeat or manual continuation | Build and verify one atomic step toward the CleanShot daily-driver dogfood gate. |

## Operating rules

- Read `STATE.md` before selecting work and update it after every run.
- One run produces one verifiable outcome and touches one task cluster.
- The Maker and Checker are different agents. The Checker is read-only.
- Only approved, allowlisted files may be staged and committed.
- Never automatically push, deploy, publish, change production data, alter CleanShot
  settings, or remove existing user files.
- Raw execution output belongs in `.run-log.txt`, which is intentionally ignored.

Manual trigger: resume the current Capso Codex task and ask it to run one iteration of
`loops/capso-cleanshot-replacement-loop.md`.
