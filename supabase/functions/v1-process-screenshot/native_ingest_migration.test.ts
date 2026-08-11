import { assert, assertMatch } from "jsr:@std/assert@1.0.14";

const migrations = Array.from(
  Deno.readDirSync(new URL("../../migrations/", import.meta.url)),
)
  .map((entry) => entry.name)
  .filter((name) => name.endsWith("_authenticated_native_ingest.sql"));

Deno.test("native ingest RPC derives ownership, is idempotent, and enqueues processing atomically", () => {
  assert(migrations.length === 1, "expected one authenticated native ingest migration");
  const sql = Deno.readTextFileSync(
    new URL(`../../migrations/${migrations[0]}`, import.meta.url),
  );

  assertMatch(sql, /security definer/i);
  assertMatch(sql, /set search_path\s*=\s*''/i);
  assertMatch(sql, /v_user_id\s*:=\s*\(select auth\.uid\(\)\)/i);
  assertMatch(sql, /originals\/.*v_user_id.*p_screenshot_id/is);
  assertMatch(sql, /thumbs\/.*v_user_id.*p_screenshot_id/is);
  assertMatch(sql, /insert into public\.screenshots/i);
  assertMatch(sql, /thumb_path/i);
  assertMatch(sql, /on conflict\s*\(id\)\s*do nothing/i);
  assertMatch(sql, /get diagnostics v_inserted\s*=\s*row_count/i);
  assertMatch(sql, /v_deduped\s*:=\s*v_inserted\s*=\s*0/i);
  assertMatch(sql, /insert into public\.jobs/i);
  assertMatch(sql, /process_capture/i);
  assertMatch(sql, /revoke execute on function public\.ingest_native_capture[\s\S]*from public/i);
  assertMatch(sql, /revoke execute on function public\.ingest_native_capture[\s\S]*from anon/i);
  assertMatch(sql, /grant execute on function public\.ingest_native_capture[\s\S]*to authenticated/i);
  assertMatch(sql, /existing capture metadata does not match/i);
});
