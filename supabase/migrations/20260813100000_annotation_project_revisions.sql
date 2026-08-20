-- Immutable editable-annotation history. This source migration is not applied
-- without explicit approval. Protected source and flattened revision pixels
-- live in a private insert-only owner bucket.

create extension if not exists pgcrypto with schema extensions;
alter extension pgcrypto set schema extensions;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'annotation-assets', 'annotation-assets', false, 26214400,
  array['image/png']
)
on conflict (id) do nothing;

drop policy if exists annotation_assets_owner_read on storage.objects;
create policy annotation_assets_owner_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'annotation-assets'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists annotation_assets_owner_insert on storage.objects;
create policy annotation_assets_owner_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'annotation-assets'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create table public.annotation_project_revisions (
  screenshot_id uuid not null,
  revision bigint not null check (revision > 0),
  user_id uuid not null references auth.users on delete cascade,
  document_revision bigint not null check (document_revision > 0),
  mutation_id uuid not null,
  mac_device_id uuid references public.mac_devices(id) on delete set null,
  original_storage_path text not null
    check (char_length(original_storage_path) between 1 and 512),
  flattened_storage_path text not null
    check (char_length(flattened_storage_path) between 1 and 512),
  original_sha256 text not null
    check (original_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  flattened_sha256 text not null
    check (flattened_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  document jsonb not null
    check (jsonb_typeof(document) = 'object')
    check (octet_length(document::text) between 2 and 8388608),
  created_at timestamptz not null default now(),
  primary key (screenshot_id, revision),
  foreign key (screenshot_id, user_id)
    references public.screenshots (id, user_id)
    on delete cascade,
  unique (user_id, mutation_id)
);

create index annotation_project_revisions_owner_current_idx
  on public.annotation_project_revisions (user_id, screenshot_id, revision desc);

alter table public.annotation_project_revisions enable row level security;

revoke all privileges on table public.annotation_project_revisions
  from anon, authenticated;
grant select on table public.annotation_project_revisions to authenticated;

create policy annotation_project_revisions_owner_read
  on public.annotation_project_revisions
  for select to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.commit_annotation_project_revision(
  p_screenshot_id uuid,
  p_base_cloud_revision bigint,
  p_document_revision bigint,
  p_mutation_id uuid,
  p_original_storage_path text,
  p_flattened_storage_path text,
  p_original_sha256 text,
  p_flattened_sha256 text,
  p_document jsonb,
  p_device_id uuid,
  p_device_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_expected_original_path text;
  v_expected_flattened_path text;
  v_original_object_name text;
  v_flattened_object_name text;
  v_head_revision bigint := 0;
  v_next_revision bigint;
  v_existing public.annotation_project_revisions%rowtype;
  v_head public.annotation_project_revisions%rowtype;
begin
  v_user_id := (select auth.uid());
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_screenshot_id is null
     or p_base_cloud_revision < 0
     or p_document_revision < 1
     or p_mutation_id is null
     or p_mutation_id = '00000000-0000-0000-0000-000000000000'::uuid
     or p_device_id is null
     or p_device_token !~ '^m_[0-9a-f]{64}$'
     or p_original_sha256 !~ '^sha256:[0-9a-f]{64}$'
     or p_flattened_sha256 !~ '^sha256:[0-9a-f]{64}$'
     or jsonb_typeof(p_document) is distinct from 'object'
     or octet_length(p_document::text) not between 2 and 8388608
     or p_document ->> 'schemaVersion' is distinct from '1'
     or p_document ->> 'captureId' is distinct from p_screenshot_id::text
     or p_document ->> 'revision' is distinct from p_document_revision::text
     or p_document ->> 'originalSha256' is distinct from p_original_sha256
     or p_document ->> 'flattenedSha256' is distinct from p_flattened_sha256
     or jsonb_typeof(p_document -> 'marks') is distinct from 'array'
     or jsonb_array_length(p_document -> 'marks') > 10000
     or (
       jsonb_array_length(p_document -> 'marks') = 0
       and coalesce(jsonb_typeof(p_document -> 'crop'), 'null') = 'null'
     ) then
    raise exception 'invalid editable annotation revision' using errcode = '22023';
  end if;

  if not exists (
    select 1
      from public.mac_devices d
     where d.id = p_device_id
       and d.user_id = v_user_id
       and d.token_hash = encode(extensions.digest(p_device_token, 'sha256'), 'hex')
       and d.revoked_at is null
  ) then
    raise exception 'This Mac was disconnected from Capso. Reconnect the same account to resume editable project sync.'
      using errcode = '28000';
  end if;

  -- The screenshot row is the per-capture serialization lock, including the
  -- first revision when no project row exists yet.
  perform 1
    from public.screenshots s
   where s.id = p_screenshot_id
     and s.user_id = v_user_id
   for update;
  if not found then
    raise exception 'editable annotation capture is unavailable' using errcode = '22023';
  end if;

  v_original_object_name := format(
    '%s/%s/original.png', v_user_id::text, p_screenshot_id::text
  );
  v_flattened_object_name := format(
    '%s/%s/revisions/%s.png',
    v_user_id::text, p_screenshot_id::text, p_mutation_id::text
  );
  v_expected_original_path := 'annotation-assets/' || v_original_object_name;
  v_expected_flattened_path := 'annotation-assets/' || v_flattened_object_name;
  if p_original_storage_path is distinct from v_expected_original_path
     or p_flattened_storage_path is distinct from v_expected_flattened_path then
    raise exception 'invalid editable annotation asset path' using errcode = '22023';
  end if;

  if not exists (
    select 1
      from storage.objects o
     where o.bucket_id = 'annotation-assets'
       and o.name = v_original_object_name
  ) or not exists (
    select 1
      from storage.objects o
     where o.bucket_id = 'annotation-assets'
       and o.name = v_flattened_object_name
  ) then
    raise exception 'editable annotation assets are not durable' using errcode = '55000';
  end if;

  select * into v_existing
    from public.annotation_project_revisions r
   where r.user_id = v_user_id
     and r.mutation_id = p_mutation_id;
  if found then
    if v_existing.screenshot_id is not distinct from p_screenshot_id
       and v_existing.document_revision is not distinct from p_document_revision
       and v_existing.original_storage_path is not distinct from p_original_storage_path
       and v_existing.flattened_storage_path is not distinct from p_flattened_storage_path
       and v_existing.original_sha256 is not distinct from p_original_sha256
       and v_existing.flattened_sha256 is not distinct from p_flattened_sha256
       and v_existing.document is not distinct from p_document then
      return jsonb_build_object(
        'status', 'committed',
        'screenshot_id', p_screenshot_id::text,
        'cloud_revision', v_existing.revision,
        'document_revision', v_existing.document_revision,
        'mutation_id', p_mutation_id::text,
        'deduped', true
      );
    end if;
    raise exception 'annotation mutation id conflicts' using errcode = '23505';
  end if;

  select coalesce(max(r.revision), 0) into v_head_revision
    from public.annotation_project_revisions r
   where r.screenshot_id = p_screenshot_id
     and r.user_id = v_user_id;
  if v_head_revision > 0 then
    select * into v_head
      from public.annotation_project_revisions r
     where r.screenshot_id = p_screenshot_id
       and r.user_id = v_user_id
       and r.revision = v_head_revision;
    if v_head.original_sha256 is distinct from p_original_sha256
       or v_head.original_storage_path is distinct from p_original_storage_path then
      raise exception 'protected annotation original changed' using errcode = '23505';
    end if;
  end if;

  if p_base_cloud_revision is distinct from v_head_revision then
    return jsonb_build_object(
      'status', 'conflict',
      'screenshot_id', p_screenshot_id::text,
      'cloud_revision', v_head_revision,
      'document_revision', p_document_revision,
      'mutation_id', p_mutation_id::text,
      'deduped', false
    );
  end if;
  v_next_revision := v_head_revision + 1;

  insert into public.annotation_project_revisions (
    screenshot_id, revision, user_id, document_revision, mutation_id,
    mac_device_id, original_storage_path, flattened_storage_path,
    original_sha256, flattened_sha256, document
  ) values (
    p_screenshot_id, v_next_revision, v_user_id, p_document_revision,
    p_mutation_id, p_device_id, p_original_storage_path,
    p_flattened_storage_path, p_original_sha256, p_flattened_sha256, p_document
  );

  update public.mac_devices
     set last_seen_at = now()
   where id = p_device_id and user_id = v_user_id and revoked_at is null;

  return jsonb_build_object(
    'status', 'committed',
    'screenshot_id', p_screenshot_id::text,
    'cloud_revision', v_next_revision,
    'document_revision', p_document_revision,
    'mutation_id', p_mutation_id::text,
    'deduped', false
  );
end;
$$;

revoke all on function public.commit_annotation_project_revision(
  uuid, bigint, bigint, uuid, text, text, text, text, jsonb, uuid, text
) from public, anon;
grant execute on function public.commit_annotation_project_revision(
  uuid, bigint, bigint, uuid, text, text, text, text, jsonb, uuid, text
) to authenticated;

create or replace function public.list_annotation_project_heads(
  p_device_id uuid,
  p_device_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_heads jsonb;
begin
  v_user_id := (select auth.uid());
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if p_device_id is null or p_device_token !~ '^m_[0-9a-f]{64}$' then
    raise exception 'invalid Mac identity' using errcode = '22023';
  end if;
  if not exists (
    select 1
      from public.mac_devices d
     where d.id = p_device_id
       and d.user_id = v_user_id
       and d.token_hash = encode(extensions.digest(p_device_token, 'sha256'), 'hex')
       and d.revoked_at is null
  ) then
    raise exception 'This Mac was disconnected from Capso. Reconnect the same account to resume editable project sync.'
      using errcode = '28000';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'screenshot_id', head.screenshot_id::text,
        'cloud_revision', head.revision,
        'document_revision', head.document_revision,
        'mutation_id', head.mutation_id::text,
        'original_storage_path', head.original_storage_path,
        'flattened_storage_path', head.flattened_storage_path,
        'original_sha256', head.original_sha256,
        'flattened_sha256', head.flattened_sha256,
        'created_at', head.created_at
      ) order by head.created_at desc, head.screenshot_id
    ),
    '[]'::jsonb
  ) into v_heads
  from (
    select latest.*
      from (
        select distinct on (r.screenshot_id)
          r.screenshot_id,
          r.revision,
          r.document_revision,
          r.mutation_id,
          r.original_storage_path,
          r.flattened_storage_path,
          r.original_sha256,
          r.flattened_sha256,
          r.created_at
        from public.annotation_project_revisions r
        where r.user_id = v_user_id
        order by r.screenshot_id, r.revision desc
      ) latest
     order by latest.created_at desc, latest.screenshot_id
     limit 500
  ) head;

  update public.mac_devices
     set last_seen_at = now()
   where id = p_device_id and user_id = v_user_id and revoked_at is null;
  return v_heads;
end;
$$;

revoke all on function public.list_annotation_project_heads(uuid, text)
  from public, anon;
grant execute on function public.list_annotation_project_heads(uuid, text)
  to authenticated;

create or replace function public.fetch_annotation_project_revision(
  p_screenshot_id uuid,
  p_revision bigint,
  p_device_id uuid,
  p_device_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_revision public.annotation_project_revisions%rowtype;
begin
  v_user_id := (select auth.uid());
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if p_screenshot_id is null
     or p_revision < 1
     or p_device_id is null
     or p_device_token !~ '^m_[0-9a-f]{64}$' then
    raise exception 'invalid editable revision request' using errcode = '22023';
  end if;
  if not exists (
    select 1
      from public.mac_devices d
     where d.id = p_device_id
       and d.user_id = v_user_id
       and d.token_hash = encode(extensions.digest(p_device_token, 'sha256'), 'hex')
       and d.revoked_at is null
  ) then
    raise exception 'This Mac was disconnected from Capso. Reconnect the same account to resume editable project sync.'
      using errcode = '28000';
  end if;

  select r.* into v_revision
    from public.annotation_project_revisions r
   where r.screenshot_id = p_screenshot_id
     and r.revision = p_revision
     and r.user_id = v_user_id;
  if not found then
    raise exception 'editable annotation revision is unavailable' using errcode = '22023';
  end if;

  return jsonb_build_object(
    'screenshot_id', v_revision.screenshot_id::text,
    'cloud_revision', v_revision.revision,
    'document_revision', v_revision.document_revision,
    'mutation_id', v_revision.mutation_id::text,
    'original_storage_path', v_revision.original_storage_path,
    'flattened_storage_path', v_revision.flattened_storage_path,
    'original_sha256', v_revision.original_sha256,
    'flattened_sha256', v_revision.flattened_sha256,
    'document', v_revision.document
  );
end;
$$;

revoke all on function public.fetch_annotation_project_revision(uuid, bigint, uuid, text)
  from public, anon;
grant execute on function public.fetch_annotation_project_revision(uuid, bigint, uuid, text)
  to authenticated;
