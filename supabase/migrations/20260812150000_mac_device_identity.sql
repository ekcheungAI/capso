-- Revocable native installation identity. A Supabase JWT proves the owner;
-- the per-installation Keychain secret proves which Mac is registering the
-- capture. This source migration is not applied without explicit approval.

create extension if not exists pgcrypto with schema extensions;
alter extension pgcrypto set schema extensions;

create table public.mac_devices (
  id uuid primary key,
  user_id uuid not null references auth.users on delete cascade,
  token_hash text not null unique
    check (token_hash ~ '^[0-9a-f]{64}$'),
  label text not null
    check (char_length(label) between 1 and 80),
  platform text not null
    check (char_length(platform) between 1 and 32),
  app_version text not null
    check (char_length(app_version) between 1 and 32),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  last_capture_at timestamptz,
  revoked_at timestamptz
);

create index mac_devices_user_created_idx
  on public.mac_devices (user_id, created_at desc);

alter table public.mac_devices enable row level security;

revoke all privileges on table public.mac_devices from anon, authenticated;
grant select (
  id, user_id, label, platform, app_version,
  created_at, last_seen_at, last_capture_at, revoked_at
) on public.mac_devices to authenticated;

create policy mac_devices_owner_read on public.mac_devices
  for select to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.register_mac_device(
  p_device_id uuid,
  p_token_hash text,
  p_label text,
  p_platform text,
  p_app_version text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_existing public.mac_devices%rowtype;
begin
  v_user_id := (select auth.uid());
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if p_device_id is null
     or p_token_hash !~ '^[0-9a-f]{64}$'
     or char_length(coalesce(p_label, '')) not between 1 and 80
     or char_length(coalesce(p_platform, '')) not between 1 and 32
     or char_length(coalesce(p_app_version, '')) not between 1 and 32 then
    raise exception 'invalid Mac device registration' using errcode = '22023';
  end if;

  insert into public.mac_devices (
    id, user_id, token_hash, label, platform, app_version, last_seen_at
  ) values (
    p_device_id, v_user_id, p_token_hash, p_label, p_platform, p_app_version, now()
  ) on conflict (id) do nothing;

  select * into v_existing
    from public.mac_devices d
   where d.id = p_device_id;
  if not found
     or v_existing.user_id is distinct from v_user_id
     or v_existing.token_hash is distinct from p_token_hash then
    raise exception 'Mac device identity conflicts with an existing installation'
      using errcode = '23505';
  end if;
  if v_existing.revoked_at is not null then
    raise exception 'This Mac was disconnected from Capso. Reconnect the same account to connect it again.'
      using errcode = '28000';
  end if;

  update public.mac_devices
     set label = p_label,
         platform = p_platform,
         app_version = p_app_version,
         last_seen_at = now()
   where id = p_device_id and user_id = v_user_id and revoked_at is null;

  return jsonb_build_object('device_id', p_device_id::text, 'registered', true);
end;
$$;

revoke all on function public.register_mac_device(
  uuid, text, text, text, text
) from public, anon;
grant execute on function public.register_mac_device(
  uuid, text, text, text, text
) to authenticated;

create or replace function public.revoke_mac_device(p_device_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed int := 0;
begin
  if (select auth.uid()) is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  update public.mac_devices
     set revoked_at = now()
   where id = p_device_id
     and user_id = (select auth.uid())
     and revoked_at is null;
  get diagnostics v_changed = row_count;
  return v_changed = 1;
end;
$$;

revoke all on function public.revoke_mac_device(uuid) from public, anon;
grant execute on function public.revoke_mac_device(uuid) to authenticated;

alter table public.screenshots
  add column mac_device_id uuid references public.mac_devices(id) on delete set null;

create index screenshots_mac_device_captured_idx
  on public.screenshots (mac_device_id, captured_at desc)
  where mac_device_id is not null;

drop function if exists public.ingest_native_capture(
  uuid, text, text, timestamptz, text, text, boolean, int, int, bigint, uuid
);

create or replace function public.ingest_native_capture(
  p_screenshot_id uuid,
  p_storage_path text,
  p_thumb_path text,
  p_captured_at timestamptz,
  p_source text,
  p_content_hash text,
  p_annotated boolean,
  p_width int,
  p_height int,
  p_bytes bigint,
  p_project_id uuid,
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
  v_expected_path text;
  v_expected_thumb_path text;
  v_existing public.screenshots%rowtype;
  v_inserted int := 0;
  v_deduped boolean := false;
begin
  v_user_id := (select auth.uid());
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_device_token !~ '^m_[0-9a-f]{64}$'
     or not exists (
       select 1
         from public.mac_devices d
        where d.id = p_device_id
          and d.user_id = v_user_id
          and d.token_hash = encode(extensions.digest(p_device_token, 'sha256'), 'hex')
          and d.revoked_at is null
     ) then
    raise exception 'This Mac was disconnected from Capso. Reconnect the same account to resume sync.'
      using errcode = '28000';
  end if;

  v_expected_path := format(
    'originals/%s/%s.png', v_user_id::text, p_screenshot_id::text
  );
  v_expected_thumb_path := format(
    'thumbs/%s/%s.png', v_user_id::text, p_screenshot_id::text
  );
  if p_storage_path is distinct from v_expected_path
     or p_thumb_path is distinct from v_expected_thumb_path
     or p_content_hash !~ '^sha256:[0-9a-f]{64}$'
     or p_source not in (
       'hotkey_region', 'hotkey_window', 'hotkey_fullscreen', 'drag', 'clipboard'
     )
     or p_captured_at is null
     or p_width not between 1 and 100000
     or p_height not between 1 and 100000
     or p_bytes not between 1 and 26214400 then
    raise exception 'invalid native capture metadata' using errcode = '22023';
  end if;

  if p_project_id is not null and not exists (
    select 1
      from public.project_threads p
     where p.id = p_project_id
       and p.user_id = v_user_id
       and p.archived_at is null
  ) then
    raise exception 'native project is not active for this owner' using errcode = '22023';
  end if;

  insert into public.screenshots (
    id, user_id, storage_path, thumb_path, width, height, bytes, source,
    project_thread_id, assignment_source, processing_status, content_hash,
    annotated, captured_at, mac_device_id
  ) values (
    p_screenshot_id, v_user_id, p_storage_path, p_thumb_path, p_width, p_height,
    p_bytes, p_source, p_project_id,
    case when p_project_id is not null
      then 'manual'::public.assignment_source else null end,
    'pending'::public.processing_status, p_content_hash, p_annotated,
    p_captured_at, p_device_id
  )
  on conflict (id) do nothing;
  get diagnostics v_inserted = row_count;

  select * into v_existing
    from public.screenshots
   where id = p_screenshot_id;
  if not found then
    raise exception 'native capture could not be persisted' using errcode = '55000';
  end if;

  v_deduped := v_inserted = 0;
  if v_existing.user_id is distinct from v_user_id
     or v_existing.storage_path is distinct from p_storage_path
     or v_existing.thumb_path is distinct from p_thumb_path
     or v_existing.content_hash is distinct from p_content_hash
     or v_existing.captured_at is distinct from p_captured_at
     or v_existing.source is distinct from p_source
     or v_existing.annotated is distinct from p_annotated
     or v_existing.mac_device_id is distinct from p_device_id
     or (p_project_id is not null and (
       v_existing.project_thread_id is distinct from p_project_id
       or v_existing.assignment_source is distinct from 'manual'::public.assignment_source
     ))
     or (p_project_id is null
       and v_existing.assignment_source = 'manual'::public.assignment_source)
     or v_existing.width is distinct from p_width
     or v_existing.height is distinct from p_height
     or v_existing.bytes is distinct from p_bytes then
    raise exception 'existing capture metadata does not match' using errcode = '23505';
  end if;

  if v_existing.processing_status <> 'processed'::public.processing_status then
    insert into public.jobs (user_id, kind, payload)
    values (
      v_user_id,
      'process_capture',
      jsonb_build_object('screenshot_id', p_screenshot_id::text)
    )
    on conflict ((payload ->> 'screenshot_id'))
      where kind = 'process_capture' and status in ('pending', 'processing')
      do nothing;
  end if;

  update public.mac_devices
     set last_seen_at = now(), last_capture_at = now()
   where id = p_device_id and user_id = v_user_id and revoked_at is null;

  return jsonb_build_object(
    'screenshot_id', p_screenshot_id::text,
    'status', 'processing',
    'deduped', v_deduped
  );
end;
$$;

revoke all on function public.ingest_native_capture(
  uuid, text, text, timestamptz, text, text, boolean, int, int, bigint,
  uuid, uuid, text
) from public, anon;
grant execute on function public.ingest_native_capture(
  uuid, text, text, timestamptz, text, text, boolean, int, int, bigint,
  uuid, uuid, text
) to authenticated;
