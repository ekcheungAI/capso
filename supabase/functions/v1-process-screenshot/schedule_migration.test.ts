import { assertMatch, assertNotMatch } from "jsr:@std/assert@1.0.14";

const migration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260810155519_schedule_screenshot_worker.sql",
    import.meta.url,
  ),
);

Deno.test("scheduled worker wakes through Vault without persisting a credential", () => {
  assertMatch(migration, /create extension if not exists pg_cron/i);
  assertMatch(migration, /create extension if not exists pg_net/i);
  assertMatch(migration, /cron\.schedule\([\s\S]+'\* \* \* \* \*'/i);
  assertMatch(migration, /x-capso-worker-secret[\s\S]+vault\.decrypted_secrets/i);
  assertMatch(migration, /where name = 'capso_worker_secret'/i);
  assertNotMatch(migration, /CAPSO_WORKER_SECRET\s*=/i);
});
