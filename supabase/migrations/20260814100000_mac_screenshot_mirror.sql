-- Bounded owner-only screenshot discovery for crash-safe Mac library mirroring.
-- This source migration is not applied without explicit approval. Screenshot
-- bytes remain in the existing private originals bucket and are downloaded via
-- its owner-scoped Storage policy.

create extension if not exists pgcrypto with schema extensions;
alter extension pgcrypto set schema extensions;

create or replace function public.list_mac_screenshot_heads(
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
    raise exception 'This Mac was disconnected from Capso. Reconnect the same account to resume screenshot sync.'
      using errcode = '28000';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'screenshot_id', head.id::text,
        'captured_at', head.captured_at,
        'storage_path', head.storage_path,
        'content_hash', head.content_hash,
        'source', head.source,
        'width', head.width,
        'height', head.height,
        'bytes', head.bytes,
        'project_thread_id', head.project_thread_id,
        'processing_status', head.processing_status::text
      ) order by head.captured_at desc, head.id
    ),
    '[]'::jsonb
  ) into v_heads
  from (
    select
      s.id,
      s.captured_at,
      s.storage_path,
      s.content_hash,
      s.source,
      s.width,
      s.height,
      s.bytes,
      s.project_thread_id,
      s.processing_status
    from public.screenshots s
    where s.user_id = v_user_id
      and s.capture_kind = 'screenshot'
      and s.archived = false
      and s.storage_path = case
        when s.source = 'extension' then format(
          'originals/%s/%s.jpg', v_user_id::text, s.id::text
        )
        else format(
          'originals/%s/%s.png', v_user_id::text, s.id::text
        )
      end
      and s.content_hash ~ '^sha256:[0-9a-f]{64}$'
      and s.source is not null
      and char_length(s.source) between 1 and 64
      and s.bytes between 8 and 26214400
      and s.width between 1 and 100000
      and s.height between 1 and 100000
    order by s.captured_at desc, s.id
    limit 500
  ) head;

  update public.mac_devices
     set last_seen_at = now()
   where id = p_device_id
     and user_id = v_user_id
     and revoked_at is null;

  return v_heads;
end;
$$;

revoke all on function public.list_mac_screenshot_heads(uuid, text)
  from public, anon;
grant execute on function public.list_mac_screenshot_heads(uuid, text)
  to authenticated;
