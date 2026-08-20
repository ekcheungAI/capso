import assert from "node:assert/strict";

let sql = "";
try {
  sql = Deno.readTextFileSync(
    new URL(
      "../../migrations/20260814100000_mac_screenshot_mirror.sql",
      import.meta.url,
    ),
  );
} catch {
  // RED stays an assertion failure until the source-only migration exists.
}

Deno.test("Mac screenshot discovery requires the signed-in owner and one active device secret", () => {
  const body = sql.match(
    /create or replace function public\.list_mac_screenshot_heads\([\s\S]+?\n\$\$;/i,
  )?.[0] ?? "";
  assert.match(body, /select auth\.uid\(\)/i);
  assert.match(body, /p_device_token !~ '\^m_\[0-9a-f\]\{64\}\$'/i);
  assert.match(
    body,
    /from public\.mac_devices[\s\S]+d\.id = p_device_id[\s\S]+d\.user_id = v_user_id[\s\S]+d\.token_hash = encode\(extensions\.digest\(p_device_token, 'sha256'\), 'hex'\)[\s\S]+d\.revoked_at is null/i,
  );
  assert.doesNotMatch(body, /set\s+token_hash\s*=\s*p_device_token/i);
});

Deno.test("Mac screenshot discovery returns a bounded newest-first owner library with exact immutable object identities", () => {
  const body = sql.match(
    /create or replace function public\.list_mac_screenshot_heads\([\s\S]+?\n\$\$;/i,
  )?.[0] ?? "";
  assert.match(body, /from public\.screenshots s/i);
  assert.match(body, /s\.user_id = v_user_id/i);
  assert.match(body, /s\.capture_kind = 'screenshot'/i);
  assert.match(body, /s\.archived = false/i);
  assert.match(body, /s\.content_hash ~ '\^sha256:\[0-9a-f\]\{64\}\$'/i);
  assert.match(
    body,
    /s\.storage_path = case[\s\S]+when s\.source = 'extension'[\s\S]+format\(\s*'originals\/%s\/%s\.jpg'[\s\S]+else format\(\s*'originals\/%s\/%s\.png'[\s\S]+end/i,
  );
  assert.match(body, /s\.bytes between 8 and 26214400/i);
  assert.match(body, /s\.width between 1 and 100000/i);
  assert.match(body, /s\.height between 1 and 100000/i);
  assert.match(body, /order by s\.captured_at desc, s\.id/i);
  assert.match(body, /limit 500/i);
});

Deno.test("Mac screenshot heads expose only the metadata needed for exact local adoption", () => {
  const body = sql.match(
    /create or replace function public\.list_mac_screenshot_heads\([\s\S]+?\n\$\$;/i,
  )?.[0] ?? "";
  for (const field of [
    "screenshot_id",
    "captured_at",
    "storage_path",
    "content_hash",
    "source",
    "width",
    "height",
    "bytes",
    "project_thread_id",
    "processing_status",
  ]) {
    assert.match(body, new RegExp(`'${field}'`, "i"));
  }
  assert.doesNotMatch(body, /'ocr_text'/i);
  assert.doesNotMatch(body, /'summary'/i);
});

Deno.test("only authenticated callers can list Mac screenshot heads", () => {
  assert.match(
    sql,
    /revoke all on function public\.list_mac_screenshot_heads\(uuid, text\)[\s\S]+?from public, anon/i,
  );
  assert.match(
    sql,
    /grant execute on function public\.list_mac_screenshot_heads\(uuid, text\)[\s\S]+?to authenticated/i,
  );
  assert.doesNotMatch(
    sql,
    /grant execute[^;]+list_mac_screenshot_heads[^;]+to anon/i,
  );
});
