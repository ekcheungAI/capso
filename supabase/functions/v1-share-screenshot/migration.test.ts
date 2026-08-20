import { assert, assertMatch } from "jsr:@std/assert@1.0.14";

const migrations = Array.from(Deno.readDirSync(new URL("../../migrations/", import.meta.url)))
  .map((entry) => entry.name)
  .filter((name) => name.endsWith("_screenshot_share_links.sql"));

Deno.test("share links store only bearer/password hashes and remain service-role-only", () => {
  assert(migrations.length === 1, "expected one screenshot-share migration");
  const sql = Deno.readTextFileSync(new URL(`../../migrations/${migrations[0]}`, import.meta.url));

  assertMatch(sql, /token_hash\s+text not null unique/i);
  assertMatch(sql, /password_hash\s+text/i);
  assertMatch(sql, /password_salt\s+text/i);
  assertMatch(sql, /foreign key \(screenshot_id, user_id\)[\s\S]*screenshots \(id, user_id\)[\s\S]*on delete cascade/i);
  assertMatch(sql, /alter table public\.screenshot_share_links enable row level security/i);
  assertMatch(sql, /revoke all privileges on table public\.screenshot_share_links from (?:public, )?anon, authenticated/i);
  assertMatch(sql, /grant select, insert, update, delete on table public\.screenshot_share_links to service_role/i);
});

Deno.test("one-time image delivery is an atomic service-role-only consume", () => {
  const sql = Deno.readTextFileSync(new URL(`../../migrations/${migrations[0]}`, import.meta.url));

  assertMatch(sql, /create or replace function public\.consume_screenshot_share/i);
  assertMatch(sql, /for update/i);
  assertMatch(sql, /expires_at > now\(\)/i);
  assertMatch(sql, /revoked_at is null/i);
  assertMatch(sql, /consumed_at is null/i);
  assertMatch(sql, /view_count = view_count \+ 1/i);
  assertMatch(sql, /consumed_at = case when v_link\.one_time then now\(\)/i);
  assertMatch(sql, /revoke all on function public\.consume_screenshot_share\(text\) from public, anon, authenticated/i);
  assertMatch(sql, /grant execute on function public\.consume_screenshot_share\(text\) to service_role/i);
});
