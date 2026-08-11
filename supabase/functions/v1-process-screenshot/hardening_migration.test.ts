import { assert, assertMatch, assertNotMatch } from "jsr:@std/assert@1.0.14";

const names = Array.from(
  Deno.readDirSync(new URL("../../migrations/", import.meta.url)),
)
  .map((entry) => entry.name)
  .filter((name) => name.endsWith("_harden_rls_and_grants.sql"));

Deno.test("remote hardening removes broad grants and secures the RLS event trigger", () => {
  assert(names.length === 1, "expected one RLS hardening migration");
  const sql = Deno.readTextFileSync(
    new URL(`../../migrations/${names[0]}`, import.meta.url),
  );

  assertMatch(
    sql,
    /revoke execute on function public\.rls_auto_enable\(\) from public, anon, authenticated/i,
  );
  assertMatch(
    sql,
    /revoke all privileges on table[\s\S]+from anon, authenticated/i,
  );
  assertMatch(
    sql,
    /grant select, insert, update, delete on table[\s\S]+to authenticated/i,
  );
  assertNotMatch(sql, /grant[^;]+truncate[^;]+to authenticated/i);
});

Deno.test("owner policies are init-plan safe and cross-owner references are impossible", () => {
  const sql = Deno.readTextFileSync(
    new URL(`../../migrations/${names[0]}`, import.meta.url),
  );

  for (
    const table of [
      "project_threads",
      "screenshots",
      "user_corrections",
      "revisit_events",
      "conversation_messages",
    ]
  ) {
    assertMatch(
      sql,
      new RegExp(
        `create policy ${table}_owner[\\s\\S]+\\(select auth\\.uid\\(\\)\\) = user_id`,
        "i",
      ),
    );
  }
  assertMatch(
    sql,
    /foreign key \(project_thread_id, user_id\)[\s\S]+references public\.project_threads \(id, user_id\)/i,
  );
  assertMatch(
    sql,
    /foreign key \(suggested_thread_id, user_id\)[\s\S]+references public\.project_threads \(id, user_id\)/i,
  );
  assertMatch(
    sql,
    /foreign key \(screenshot_id, user_id\)[\s\S]+references public\.screenshots \(id, user_id\)/i,
  );
});

Deno.test("foreign-key lookup paths have covering indexes", () => {
  const sql = Deno.readTextFileSync(
    new URL(`../../migrations/${names[0]}`, import.meta.url),
  );

  for (
    const name of [
      "conversation_messages_user_idx",
      "revisit_events_user_idx",
      "screenshots_suggested_thread_idx",
      "user_corrections_screenshot_idx",
    ]
  ) {
    assertMatch(sql, new RegExp(`create index ${name}`, "i"));
  }
});

Deno.test("owner-composite foreign keys receive exact covering indexes", () => {
  const coverNames = Array.from(
    Deno.readDirSync(new URL("../../migrations/", import.meta.url)),
  )
    .map((entry) => entry.name)
    .filter((name) => name.endsWith("_cover_owner_foreign_keys.sql"));
  assert(coverNames.length === 1, "expected one owner FK index migration");
  const sql = Deno.readTextFileSync(
    new URL(`../../migrations/${coverNames[0]}`, import.meta.url),
  );

  assertMatch(
    sql,
    /conversation_messages \(project_thread_id, user_id\)/i,
  );
  assertMatch(sql, /jobs \(user_id\)/i);
  assertMatch(sql, /revisit_events \(screenshot_id, user_id\)/i);
  assertMatch(sql, /screenshots \(project_thread_id, user_id\)/i);
});
