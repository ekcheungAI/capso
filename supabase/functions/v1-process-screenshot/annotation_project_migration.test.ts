import assert from "node:assert/strict";

let sql = "";
try {
  sql = Deno.readTextFileSync(
    new URL(
      "../../migrations/20260813100000_annotation_project_revisions.sql",
      import.meta.url,
    ),
  );
} catch {
  // RED stays an assertion failure until the migration contract exists.
}

Deno.test("editable project history is append-only, owner-readable and never directly writable", () => {
  assert.match(sql, /create table public\.annotation_project_revisions/i);
  assert.match(sql, /primary key \(screenshot_id, revision\)/i);
  assert.match(sql, /foreign key \(screenshot_id, user_id\)[\s\S]+screenshots \(id, user_id\)[\s\S]+on delete cascade/i);
  assert.match(sql, /alter table public\.annotation_project_revisions enable row level security/i);
  assert.match(sql, /create policy annotation_project_revisions_owner_read[\s\S]+for select to authenticated[\s\S]+auth\.uid\(\)[\s\S]+user_id/i);
  assert.match(sql, /grant select[\s\S]+on table public\.annotation_project_revisions to authenticated/i);
  assert.doesNotMatch(sql, /grant (?:insert|update|delete|all)[^;]+annotation_project_revisions[^;]+authenticated/i);
});

Deno.test("editable project pixels are immutable private owner assets", () => {
  assert.match(sql, /'annotation-assets',\s*'annotation-assets',\s*false,\s*26214400/i);
  assert.match(sql, /create policy annotation_assets_owner_read[\s\S]+for select to authenticated/i);
  assert.match(sql, /create policy annotation_assets_owner_insert[\s\S]+for insert to authenticated/i);
  assert.match(sql, /storage\.foldername\(name\)\)\[1\] = \(select auth\.uid\(\)\)::text/i);
  assert.doesNotMatch(sql, /create policy annotation_assets[^;]+for (?:all|update|delete)/i);
});

Deno.test("project commit serializes on the owned screenshot and rejects a stale cloud base", () => {
  const body = sql.match(
    /create or replace function public\.commit_annotation_project_revision\([\s\S]+?\n\$\$;/i,
  )?.[0] ?? "";
  assert.match(body, /from public\.screenshots[\s\S]+for update/i);
  assert.match(body, /where s\.id = p_screenshot_id[\s\S]+s\.user_id = v_user_id/i);
  assert.match(body, /coalesce\(max\(r\.revision\), 0\)/i);
  assert.match(body, /p_base_cloud_revision is distinct from v_head_revision/i);
  assert.match(body, /return jsonb_build_object\([\s\S]+'status', 'conflict'[\s\S]+'cloud_revision', v_head_revision/i);
  assert.doesNotMatch(body, /raise exception 'editable annotation conflict'/i);
  assert.match(body, /v_next_revision := v_head_revision \+ 1/i);
  assert.match(body, /insert into public\.annotation_project_revisions/i);
  assert.doesNotMatch(body, /on conflict \(screenshot_id\)[\s\S]+do update/i);
});

Deno.test("project commit binds owner, active Mac, canonical immutable paths and bounded document hashes", () => {
  const body = sql.match(
    /create or replace function public\.commit_annotation_project_revision\([\s\S]+?\n\$\$;/i,
  )?.[0] ?? "";
  assert.match(body, /from public\.mac_devices[\s\S]+token_hash = encode\(extensions\.digest\(p_device_token, 'sha256'\), 'hex'\)[\s\S]+revoked_at is null/i);
  assert.match(body, /'%s\/%s\/original\.png'[\s\S]+v_expected_original_path := 'annotation-assets\/'/i);
  assert.match(body, /'%s\/%s\/revisions\/%s\.png'[\s\S]+p_mutation_id[\s\S]+v_expected_flattened_path := 'annotation-assets\/'/i);
  assert.match(body, /p_original_sha256 !~ '\^sha256:\[0-9a-f\]\{64\}\$'/i);
  assert.match(body, /p_flattened_sha256 !~ '\^sha256:\[0-9a-f\]\{64\}\$'/i);
  assert.match(body, /octet_length\(p_document::text\) not between 2 and 8388608/i);
  assert.match(body, /p_document ->> 'captureId'[\s\S]+p_screenshot_id::text/i);
  assert.match(body, /p_document ->> 'revision'[\s\S]+p_document_revision::text/i);
  assert.match(body, /jsonb_array_length\(p_document -> 'marks'\) > 10000/i);
});

Deno.test("project commit is exact-mutation idempotent and keeps the protected original invariant", () => {
  const body = sql.match(
    /create or replace function public\.commit_annotation_project_revision\([\s\S]+?\n\$\$;/i,
  )?.[0] ?? "";
  assert.match(body, /where r\.user_id = v_user_id[\s\S]+r\.mutation_id = p_mutation_id/i);
  assert.match(body, /v_existing\.document is not distinct from p_document/i);
  assert.match(body, /raise exception 'annotation mutation id conflicts'/i);
  assert.match(body, /v_head\.original_sha256 is distinct from p_original_sha256/i);
  assert.match(body, /raise exception 'protected annotation original changed'/i);
  assert.match(body, /from storage\.objects[\s\S]+bucket_id = 'annotation-assets'/i);
});

Deno.test("only authenticated owners can call the project commit RPC", () => {
  assert.match(sql, /revoke all on function public\.commit_annotation_project_revision\([\s\S]+?from public, anon/i);
  assert.match(sql, /grant execute on function public\.commit_annotation_project_revision\([\s\S]+?to authenticated/i);
  assert.doesNotMatch(sql, /grant execute[^;]+commit_annotation_project_revision[^;]+to anon/i);
});

Deno.test("cross-Mac discovery returns one bounded owner head per screenshot without project documents", () => {
  const body = sql.match(
    /create or replace function public\.list_annotation_project_heads\([\s\S]+?\n\$\$;/i,
  )?.[0] ?? "";
  assert.match(body, /select auth\.uid\(\)/i);
  assert.match(body, /from public\.mac_devices[\s\S]+token_hash = encode\(extensions\.digest\(p_device_token, 'sha256'\), 'hex'\)[\s\S]+revoked_at is null/i);
  assert.match(body, /distinct on \(r\.screenshot_id\)/i);
  assert.match(body, /order by r\.screenshot_id, r\.revision desc/i);
  assert.match(body, /where r\.user_id = v_user_id/i);
  assert.match(body, /limit 500/i);
  assert.doesNotMatch(body, /'document',\s*(?:r|head)\.document/i);
  assert.match(sql, /revoke all on function public\.list_annotation_project_heads\([\s\S]+?from public, anon/i);
  assert.match(sql, /grant execute on function public\.list_annotation_project_heads\([\s\S]+?to authenticated/i);
});

Deno.test("cross-Mac revision fetch rechecks owner and active device before returning one exact document", () => {
  const body = sql.match(
    /create or replace function public\.fetch_annotation_project_revision\([\s\S]+?\n\$\$;/i,
  )?.[0] ?? "";
  assert.match(body, /select auth\.uid\(\)/i);
  assert.match(body, /from public\.mac_devices[\s\S]+revoked_at is null/i);
  assert.match(body, /r\.screenshot_id = p_screenshot_id/i);
  assert.match(body, /r\.revision = p_revision/i);
  assert.match(body, /r\.user_id = v_user_id/i);
  assert.match(body, /'document',\s*v_revision\.document/i);
  assert.match(sql, /revoke all on function public\.fetch_annotation_project_revision\([\s\S]+?from public, anon/i);
  assert.match(sql, /grant execute on function public\.fetch_annotation_project_revision\([\s\S]+?to authenticated/i);
});
