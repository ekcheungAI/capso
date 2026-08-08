-- Native macOS ingestion boundary. This migration is source-controlled and
-- locally verified, but deliberately not applied without the owner's explicit
-- production migration approval.

alter table public.screenshots
  add column if not exists annotated boolean not null default false;

create or replace function public.ingest_native_capture(
  p_screenshot_id uuid,
  p_storage_path text,
  p_captured_at timestamptz,
  p_source text,
  p_content_hash text,
  p_annotated boolean,
  p_width int,
  p_height int,
  p_bytes bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_expected_path text;
  v_existing public.screenshots%rowtype;
  v_inserted int := 0;
  v_deduped boolean := false;
begin
  -- Ownership comes only from the verified Supabase JWT. There is no user-id
  -- argument for a native client to spoof.
  v_user_id := (select auth.uid());
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  v_expected_path := format(
    'originals/%s/%s.png',
    v_user_id::text,
    p_screenshot_id::text
  );
  if p_storage_path is distinct from v_expected_path
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

  insert into public.screenshots (
    id,
    user_id,
    storage_path,
    width,
    height,
    bytes,
    source,
    processing_status,
    content_hash,
    annotated,
    captured_at
  )
  values (
    p_screenshot_id,
    v_user_id,
    p_storage_path,
    p_width,
    p_height,
    p_bytes,
    p_source,
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
     or v_existing.content_hash is distinct from p_content_hash
     or v_existing.captured_at is distinct from p_captured_at
     or v_existing.source is distinct from p_source
     or v_existing.annotated is distinct from p_annotated
     or v_existing.width is distinct from p_width
     or v_existing.height is distinct from p_height
     or v_existing.bytes is distinct from p_bytes then
    raise exception 'existing capture metadata does not match' using errcode = '23505';
  end if;

  -- The screenshot and job are committed in the same transaction. A retry
  -- after an acknowledgement loss cannot enqueue a second active job, and an
  -- already-processed screenshot never causes a second paid model call.
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

revoke execute on function public.ingest_native_capture(
  uuid, text, timestamptz, text, text, boolean, int, int, bigint
) from public;
revoke execute on function public.ingest_native_capture(
  uuid, text, timestamptz, text, text, boolean, int, int, bigint
) from anon;
grant execute on function public.ingest_native_capture(
  uuid, text, timestamptz, text, text, boolean, int, int, bigint
) to authenticated;
