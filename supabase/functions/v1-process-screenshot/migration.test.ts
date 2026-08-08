import assert from "node:assert/strict";

const migration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260808032950_background_processing_jobs.sql",
    import.meta.url,
  ),
);

Deno.test("job schema keeps owner reads RLS-scoped and worker mutations service-role-only", () => {
  assert.match(
    migration,
    /alter table public\.jobs enable row level security/i,
  );
  assert.match(migration, /using \(\(select auth\.uid\(\)\) = user_id\)/i);
  assert.match(
    migration,
    /revoke all on function public\.claim_process_capture_job\(text\) from public, anon, authenticated/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.claim_process_capture_job\(text\) to service_role/i,
  );
  assert.doesNotMatch(migration, /grant execute[^;]+to authenticated/i);
});

Deno.test("claim contract is one-job, skip-locked, serial per owner, and restart-safe", () => {
  assert.match(migration, /for update of j skip locked/i);
  assert.match(migration, /select min\(head\.id\)/i);
  assert.match(migration, /active\.status = 'processing'/i);
  assert.match(
    migration,
    /locked_at < clock_timestamp\(\) - interval '10 minutes'/i,
  );
  assert.match(
    migration,
    /status = 'failed'[\s\S]+attempts >= max_attempts[\s\S]+status = 'pending'[\s\S]+attempts < max_attempts/i,
  );
  assert.match(migration, /s\.processing_status <> 'processed'/i);
  assert.match(migration, /s\.storage_path is not null/i);
});

Deno.test("settlement owns the exact lease and uses bounded persisted retry codes", () => {
  assert.match(migration, /j\.locked_by = p_worker_id/i);
  assert.match(migration, /processing_status = 'processed'/i);
  assert.match(migration, /processing_status = 'unprocessed'/i);
  assert.match(migration, /when 1 then interval '5 seconds'/i);
  assert.match(migration, /when 2 then interval '30 seconds'/i);
  assert.match(migration, /else interval '2 minutes'/i);
  assert.match(migration, /p_error_code !~ '\^\[a-z_\]\{1,64\}\$'/i);
});
