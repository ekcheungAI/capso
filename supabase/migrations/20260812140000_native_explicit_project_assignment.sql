-- Capture-time filing for the native Mac client. The authenticated JWT remains
-- the only source of ownership; a client-supplied project is accepted only when
-- it is active and belongs to that exact owner.

drop function if exists public.ingest_native_capture(
  uuid, text, text, timestamptz, text, text, boolean, int, int, bigint
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
  v_user_id := (select auth.uid());
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  v_expected_path := format(
    'originals/%s/%s.png',
    v_user_id::text,
    p_screenshot_id::text
  );
  v_expected_thumb_path := format(
    'thumbs/%s/%s.png',
    v_user_id::text,
    p_screenshot_id::text
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
    id,
    user_id,
    storage_path,
    thumb_path,
    width,
    height,
    bytes,
    source,
    project_thread_id,
    assignment_source,
    processing_status,
    content_hash,
    annotated,
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
    p_source,
    p_project_id,
    case
      when p_project_id is not null then 'manual'::public.assignment_source
      else null
    end,
    'pending'::public.processing_status,
    p_content_hash,
    p_annotated,
    p_captured_at
  )
  on conflict (id) do nothing;
  get diagnostics v_inserted = row_count;

  select *
    into v_existing
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

  return jsonb_build_object(
    'screenshot_id', p_screenshot_id::text,
    'status', 'processing',
    'deduped', v_deduped
  );
end;
$$;

revoke all on function public.ingest_native_capture(
  uuid, text, text, timestamptz, text, text, boolean, int, int, bigint, uuid
) from public, anon;
grant execute on function public.ingest_native_capture(
  uuid, text, text, timestamptz, text, text, boolean, int, int, bigint, uuid
) to authenticated;
