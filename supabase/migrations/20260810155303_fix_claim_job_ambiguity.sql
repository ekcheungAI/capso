-- `returns table` exposes output columns as PL/pgSQL variables. Qualify every
-- jobs column that shares an output name so an empty queue returns `idle`
-- instead of failing with PostgreSQL error 42702.
create or replace function public.claim_process_capture_job(p_worker_id text)
returns table (
  job_id bigint,
  user_id uuid,
  screenshot_id uuid,
  storage_path text,
  attempts int,
  max_attempts int,
  page_url text,
  page_title text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job_id bigint;
begin
  if p_worker_id !~ '^[A-Za-z0-9_-]{8,128}$' then
    raise exception 'invalid worker identity' using errcode = '22023';
  end if;

  with exhausted as (
    update public.jobs as j
       set status = 'failed',
           locked_at = null,
           locked_by = null,
           last_error = 'lease_expired'
     where j.status = 'processing'
       and j.locked_at < clock_timestamp() - interval '10 minutes'
       and j.attempts >= j.max_attempts
    returning j.user_id, j.payload
  )
  update public.screenshots as s
     set processing_status = 'unprocessed'
    from exhausted as e
   where s.id::text = e.payload ->> 'screenshot_id'
     and s.user_id = e.user_id
     and s.processing_status <> 'processed';

  update public.jobs as j
     set status = 'pending', locked_at = null, locked_by = null
   where j.status = 'processing'
     and j.locked_at < clock_timestamp() - interval '10 minutes'
     and j.attempts < j.max_attempts;

  update public.jobs as j
     set status = 'done', locked_at = null, locked_by = null, last_error = null
   where j.kind = 'process_capture'
     and j.status in ('pending', 'processing')
     and not exists (
       select 1
         from public.screenshots as s
        where s.id::text = j.payload ->> 'screenshot_id'
          and s.user_id = j.user_id
          and s.processing_status <> 'processed'
     );

  select j.id
    into v_job_id
    from public.jobs as j
    join public.screenshots as s
      on s.id::text = j.payload ->> 'screenshot_id'
     and s.user_id = j.user_id
   where j.kind = 'process_capture'
     and j.status = 'pending'
     and j.run_after <= clock_timestamp()
     and s.processing_status <> 'processed'
     and s.storage_path is not null
     and not exists (
       select 1 from public.jobs as active
        where active.user_id = j.user_id
          and active.status = 'processing'
     )
     and j.id = (
       select min(head.id)
         from public.jobs as head
         join public.screenshots as head_s
           on head_s.id::text = head.payload ->> 'screenshot_id'
          and head_s.user_id = head.user_id
        where head.user_id = j.user_id
          and head.kind = 'process_capture'
          and head.status = 'pending'
          and head.run_after <= clock_timestamp()
          and head_s.processing_status <> 'processed'
          and head_s.storage_path is not null
     )
   order by j.run_after, j.id
   for update of j skip locked
   limit 1;

  if v_job_id is null then
    return;
  end if;

  update public.jobs as j
     set status = 'processing',
         attempts = j.attempts + 1,
         locked_at = clock_timestamp(),
         locked_by = p_worker_id,
         last_error = null
   where j.id = v_job_id;

  return query
  select j.id,
         j.user_id,
         s.id,
         s.storage_path,
         j.attempts,
         j.max_attempts,
         s.page_url,
         s.page_title
    from public.jobs as j
    join public.screenshots as s
      on s.id::text = j.payload ->> 'screenshot_id'
     and s.user_id = j.user_id
   where j.id = v_job_id;
end;
$$;
