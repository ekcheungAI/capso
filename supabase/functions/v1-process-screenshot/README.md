# Background screenshot worker

`v1-process-screenshot` is an internal Supabase Edge Function. One authorized
POST claims at most one persisted `process_capture` job, loads that owner's
exact stored PNG plus bounded project/correction context, calls MiniMax once
(with one schema-repair retry), and atomically settles the screenshot and job.

It is deliberately not a browser endpoint. `verify_jwt = false` lets a future
Supabase Cron request reach the handler, but the handler rejects every request
without the constant-time `x-capso-worker-secret` check before it touches
storage, Postgres, or the model.

## Local verification

From
`~/Desktop/ekOS/20_projects/Capso/supabase/functions/v1-process-screenshot`:

```sh
deno fmt --check .
deno task test
deno task check
deno info index.ts
```

The tests use in-memory ports and fetch doubles. They do not need production
credentials, make model calls, apply a migration, or deploy anything.

## Required hosted secrets

- `CAPSO_WORKER_SECRET` — random value of at least 32 characters; future Cron
  configuration must read it from Supabase Vault.
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `MINIMAX_TEXT_API_KEY`
- `MINIMAX_API_BASE_URL` — optional; defaults to `https://api.minimax.io`.
- `MINIMAX_MODEL` — optional; defaults to `MiniMax-M3`.

Applying the migration, setting secrets, deploying this function, creating its
job producer, and scheduling Cron are separate owner-approved production gates.
Until those are complete, this is a locally verified worker core, not an active
background-learning pipeline.
