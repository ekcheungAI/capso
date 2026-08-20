-- Durable Chrome-extension identity and direct capture ingestion.
--
-- The previous `/api/ingest` relay only held bytes in one Next.js process. A
-- Capso tab had to be open to move those bytes into the owner's library. The
-- extension itself remains the durable retry queue; this migration gives it a
-- scoped, revocable device identity and an atomic database boundary once the
-- Storage objects have landed.

create table public.extension_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  token_hash text not null unique
    check (token_hash ~ '^[0-9a-f]{64}$'),
  label text not null default 'Chrome extension'
    check (char_length(label) between 1 and 80),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  last_capture_at timestamptz,
  revoked_at timestamptz
);

create index extension_devices_user_created_idx
  on public.extension_devices (user_id, created_at desc);

alter table public.extension_devices enable row level security;

revoke all privileges on table public.extension_devices from anon, authenticated;
grant select, insert, update, delete on table public.extension_devices to authenticated;

create policy extension_devices_owner on public.extension_devices
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create or replace function public.ingest_extension_capture(
  p_device_id uuid,
  p_screenshot_id uuid,
  p_storage_path text,
  p_thumb_path text,
  p_captured_at timestamptz,
  p_content_hash text,
  p_width int,
  p_height int,
  p_bytes bigint,
  p_page_url text,
  p_page_title text,
  p_source_app text,
  p_project_id uuid
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
  -- Ownership comes from the registered, non-revoked device. There is no owner
  -- id in the public transport for an extension to spoof.
  select d.user_id
    into v_user_id
    from public.extension_devices d
   where d.id = p_device_id
     and d.revoked_at is null;

  if v_user_id is null then
    raise exception 'extension device is not active' using errcode = '28000';
  end if;

  v_expected_path := format(
    'originals/%s/%s.jpg',
    v_user_id::text,
    p_screenshot_id::text
  );
  v_expected_thumb_path := format(
    'thumbs/%s/%s.webp',
    v_user_id::text,
    p_screenshot_id::text
  );

  if p_storage_path is distinct from v_expected_path
     or p_thumb_path is distinct from v_expected_thumb_path
     or p_content_hash !~ '^sha256:[0-9a-f]{64}$'
     or p_captured_at is null
     or p_width not between 1 and 100000
     or p_height not between 1 and 100000
     or p_bytes not between 1 and 26214400
     or char_length(coalesce(p_page_url, '')) > 2048
     or char_length(coalesce(p_page_title, '')) > 512
     or char_length(coalesce(p_source_app, '')) > 128 then
    raise exception 'invalid extension capture metadata' using errcode = '22023';
  end if;

  if p_project_id is not null and not exists (
    select 1
      from public.project_threads p
     where p.id = p_project_id
       and p.user_id = v_user_id
       and p.archived_at is null
  ) then
    raise exception 'extension project is not active for this owner' using errcode = '22023';
  end if;

  insert into public.screenshots (
    id,
    user_id,
    storage_path,
    thumb_path,
    width,
    height,
    bytes,
    source,
    source_app,
    page_url,
    page_title,
    project_thread_id,
    assignment_source,
    processing_status,
    content_hash,
    captured_at
  )
  values (
    p_screenshot_id,
    v_user_id,
    p_storage_path,
    p_thumb_path,
    p_width,
    p_height,
    p_bytes,
    'extension',
    nullif(p_source_app, ''),
    nullif(p_page_url, ''),
    nullif(p_page_title, ''),
    p_project_id,
    case
      when p_project_id is not null then 'manual'::public.assignment_source
      else null
    end,
    'pending'::public.processing_status,
    p_content_hash,
    p_captured_at
  )
  on conflict (id) do nothing;
  get diagnostics v_inserted = row_count;

  select *
    into v_existing
    from public.screenshots
   where id = p_screenshot_id;

  if not found then
    raise exception 'extension capture could not be persisted' using errcode = '55000';
  end if;

  v_deduped := v_inserted = 0;
  if v_existing.user_id is distinct from v_user_id
     or v_existing.storage_path is distinct from p_storage_path
     or v_existing.thumb_path is distinct from p_thumb_path
     or v_existing.content_hash is distinct from p_content_hash
     or v_existing.captured_at is distinct from p_captured_at
     or v_existing.source is distinct from 'extension'
     or (
       p_project_id is not null
       and (
         v_existing.project_thread_id is distinct from p_project_id
         or v_existing.assignment_source is distinct from 'manual'::public.assignment_source
       )
     )
     or (
       p_project_id is null
       and v_existing.assignment_source = 'manual'::public.assignment_source
     )
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

  update public.extension_devices
     set last_seen_at = now(),
         last_capture_at = now()
   where id = p_device_id;

  return jsonb_build_object(
    'screenshot_id', p_screenshot_id::text,
    'status', 'processing',
    'deduped', v_deduped
  );
end;
$$;

revoke all on function public.ingest_extension_capture(
  uuid, uuid, text, text, timestamptz, text, int, int, bigint, text, text, text, uuid
) from public, anon, authenticated;
grant execute on function public.ingest_extension_capture(
  uuid, uuid, text, text, timestamptz, text, int, int, bigint, text, text, text, uuid
) to service_role;
