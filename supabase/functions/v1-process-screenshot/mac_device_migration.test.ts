import { assertMatch } from "jsr:@std/assert@1.0.14";

const sql = Deno.readTextFileSync(
  new URL(
    "../../migrations/20260812150000_mac_device_identity.sql",
    import.meta.url,
  ),
);

Deno.test("Mac identity stores only a fingerprint and exposes owner-readable metadata", () => {
  assertMatch(sql, /create table public\.mac_devices/i);
  assertMatch(sql, /token_hash text not null unique/i);
  assertMatch(sql, /alter table public\.mac_devices enable row level security/i);
  assertMatch(sql, /mac_devices_owner_read[\s\S]*auth\.uid\(\)/i);
  assertMatch(sql, /revoke all privileges on table public\.mac_devices/i);
  assertMatch(sql, /grant select \([\s\S]*revoked_at[\s\S]*\) on public\.mac_devices/i);
  assertMatch(sql, /security definer[\s\S]*register_mac_device/i);
  assertMatch(sql, /v_existing\.revoked_at is not null[\s\S]*disconnected/i);
});

Deno.test("native ingest requires JWT owner and the exact active Keychain device secret", () => {
  assertMatch(sql, /v_user_id := \(select auth\.uid\(\)\)/i);
  assertMatch(
    sql,
    /d\.id = p_device_id[\s\S]*d\.user_id = v_user_id[\s\S]*extensions\.digest\(p_device_token/i,
  );
  assertMatch(sql, /d\.revoked_at is null/i);
  assertMatch(sql, /mac_device_id is distinct from p_device_id/i);
  assertMatch(sql, /last_capture_at = now\(\)/i);
  assertMatch(
    sql,
    /grant execute on function public\.ingest_native_capture[\s\S]*to authenticated/i,
  );
});

Deno.test("remote Mac disconnect is owner-scoped and cannot un-revoke a row", () => {
  assertMatch(sql, /create or replace function public\.revoke_mac_device/i);
  assertMatch(
    sql,
    /where id = p_device_id[\s\S]*user_id = \(select auth\.uid\(\)\)[\s\S]*revoked_at is null/i,
  );
  assertMatch(sql, /set revoked_at = now\(\)/i);
  assertMatch(sql, /grant execute on function public\.revoke_mac_device\(uuid\) to authenticated/i);
});
