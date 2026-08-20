import { assert, assertMatch } from "jsr:@std/assert@1.0.14";

const migrations = Array.from(
  Deno.readDirSync(new URL("../../migrations/", import.meta.url)),
)
  .map((entry) => entry.name)
  .filter((name) => name.endsWith("_extension_direct_ingest.sql"));

Deno.test("extension migration keeps raw codes out of Postgres and derives capture ownership from an active device", () => {
  assert(migrations.length === 1, "expected one extension direct-ingest migration");
  const sql = Deno.readTextFileSync(
    new URL(`../../migrations/${migrations[0]}`, import.meta.url),
  );
  assertMatch(sql, /token_hash text not null unique/i);
  assertMatch(sql, /alter table public\.extension_devices enable row level security/i);
  assertMatch(sql, /extension_devices_owner[\s\S]*auth\.uid\(\)/i);
  assertMatch(sql, /select d\.user_id[\s\S]*d\.revoked_at is null/i);
  assertMatch(sql, /originals\/%s\/%s\.jpg/i);
  assertMatch(sql, /thumbs\/%s\/%s\.webp/i);
  assertMatch(sql, /insert into public\.screenshots/i);
  assertMatch(sql, /p\.id = p_project_id[\s\S]*p\.user_id = v_user_id/i);
  assertMatch(sql, /p_project_id[\s\S]*'manual'::public\.assignment_source/i);
  assertMatch(
    sql,
    /p_project_id is null[\s\S]*assignment_source = 'manual'::public\.assignment_source/i,
  );
  assertMatch(sql, /insert into public\.jobs/i);
  assertMatch(sql, /on conflict \(\(payload ->> 'screenshot_id'\)\)/i);
  assertMatch(sql, /revoke all on function public\.ingest_extension_capture[\s\S]*authenticated/i);
  assertMatch(sql, /grant execute on function public\.ingest_extension_capture[\s\S]*service_role/i);
});

Deno.test("native ingest validates an explicit active owner project and records manual provenance", () => {
  const sql = Deno.readTextFileSync(
    new URL(
      "../../migrations/20260812140000_native_explicit_project_assignment.sql",
      import.meta.url,
    ),
  );
  assertMatch(sql, /v_user_id := \(select auth\.uid\(\)\)/i);
  assertMatch(
    sql,
    /p\.id = p_project_id[\s\S]*p\.user_id = v_user_id[\s\S]*p\.archived_at is null/i,
  );
  assertMatch(sql, /project_thread_id,[\s\S]*assignment_source/i);
  assertMatch(sql, /p_project_id[\s\S]*'manual'::public\.assignment_source/i);
  assertMatch(
    sql,
    /p_project_id is null[\s\S]*assignment_source = 'manual'::public\.assignment_source/i,
  );
  assertMatch(sql, /insert into public\.jobs/i);
  assertMatch(
    sql,
    /grant execute on function public\.ingest_native_capture[\s\S]*authenticated/i,
  );
});

Deno.test("worker completion preserves an explicit owner assignment while still recording AI suggestion", () => {
  const sql = Deno.readTextFileSync(
    new URL(
      "../../migrations/20260812130000_preserve_explicit_project_assignment.sql",
      import.meta.url,
    ),
  );
  assertMatch(sql, /suggested_thread_id = p_suggested_thread_id/i);
  assertMatch(
    sql,
    /project_thread_id = case[\s\S]*when assignment_source is null[\s\S]*else project_thread_id/i,
  );
  assertMatch(
    sql,
    /when assignment_source is null and p_auto_assign_thread_id is not null[\s\S]*'auto'/i,
  );
});
