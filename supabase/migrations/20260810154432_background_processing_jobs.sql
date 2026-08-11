-- Browser-independent screenshot processing. This migration is committed but
-- deliberately not applied by the hourly loop: production schema changes are
-- an owner STOP gate (20_AGENT_LOOP_INSTRUCTIONS.md §7).

create type public.job_status as enum ('pending', 'processing', 'done', 'failed');

create table public.jobs (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  kind         text not null check (kind in ('process_capture', 'embed')),
  payload      jsonb not null,
  status       public.job_status not null default 'pending',
  attempts     int not null default 0 check (attempts >= 0),
  max_attempts int not null default 3 check (max_attempts between 1 and 10),
  run_after    timestamptz not null default now(),
  locked_at    timestamptz,
  locked_by    text,
  last_error   text,
  created_at   timestamptz not null default now(),
  check (kind <> 'process_capture' or payload ? 'screenshot_id')
);

create index jobs_due_idx
  on public.jobs (status, run_after, id)
  where status in ('pending', 'processing');

create unique index jobs_active_process_capture_idx
  on public.jobs ((payload ->> 'screenshot_id'))
  where kind = 'process_capture' and status in ('pending', 'processing');

alter table public.jobs enable row level security;

create policy jobs_owner_read on public.jobs
  for select to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table public.jobs from anon, authenticated;
grant select (id, kind, status, attempts, max_attempts, run_after, last_error, created_at)
  on public.jobs to authenticated;

-- Claim at most one due job. The `min(id)` head condition prevents two
-- concurrent SKIP LOCKED callers from claiming different jobs for the same
-- user, preserving the serial-per-user cost boundary from 14 §6.
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

  -- An interrupted invocation cannot strand work forever. Exhausted leases are
  -- terminal; eligible leases may be reclaimed without exceeding the paid-call
  -- budget. Exact completion is idempotent, so ten minutes is the lease window.
  with exhausted as (
    update public.jobs
       set status = 'failed',
           locked_at = null,
           locked_by = null,
           last_error = 'lease_expired'
     where status = 'processing'
       and locked_at < clock_timestamp() - interval '10 minutes'
       and attempts >= max_attempts
    returning user_id, payload
  )
  update public.screenshots as s
     set processing_status = 'unprocessed'
    from exhausted as e
   where s.id::text = e.payload ->> 'screenshot_id'
     and s.user_id = e.user_id
     and s.processing_status <> 'processed';

  update public.jobs
     set status = 'pending', locked_at = null, locked_by = null
   where status = 'processing'
     and locked_at < clock_timestamp() - interval '10 minutes'
     and attempts < max_attempts;

  -- A duplicate active job for an already-processed or deleted screenshot is
  -- complete by definition and must never trigger another paid model call.
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

create or replace function public.complete_process_capture_job(
  p_job_id bigint,
  p_worker_id text,
  p_result jsonb,
  p_suggested_thread_id uuid,
  p_auto_assign_thread_id uuid,
  p_search_text text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_screenshot_id uuid;
begin
  select j.user_id, s.id
    into v_user_id, v_screenshot_id
    from public.jobs as j
    join public.screenshots as s
      on s.id::text = j.payload ->> 'screenshot_id'
     and s.user_id = j.user_id
   where j.id = p_job_id
     and j.kind = 'process_capture'
     and j.status = 'processing'
     and j.locked_by = p_worker_id
   for update of j, s;

  if not found then
    raise exception 'worker does not own this job' using errcode = '55000';
  end if;

  if jsonb_typeof(p_result) <> 'object'
     or not (p_result ?& array[
       'title', 'ocr_text', 'summary', 'type', 'intent',
       'project_suggestion', 'confidence', 'why_saved', 'tags'
     ]) then
    raise exception 'invalid classification result' using errcode = '22023';
  end if;

  if p_suggested_thread_id is not null and not exists (
    select 1 from public.project_threads
     where id = p_suggested_thread_id and user_id = v_user_id
  ) then
    raise exception 'suggested project is not owned by job user' using errcode = '22023';
  end if;

  if p_auto_assign_thread_id is not null
     and (p_auto_assign_thread_id is distinct from p_suggested_thread_id) then
    raise exception 'auto assignment must equal the validated suggestion' using errcode = '22023';
  end if;

  update public.screenshots
     set title = p_result ->> 'title',
         ocr_text = p_result ->> 'ocr_text',
         summary = p_result ->> 'summary',
         type = p_result ->> 'type',
         intent = (p_result ->> 'intent')::public.capture_intent,
         confidence = (p_result ->> 'confidence')::real,
         why_saved = p_result ->> 'why_saved',
         tags = array(select jsonb_array_elements_text(p_result -> 'tags')),
         ocr_source = 'llm'::public.ocr_source,
         simulated = false,
         search_text = p_search_text,
         suggested_thread_id = p_suggested_thread_id,
         project_thread_id = coalesce(p_auto_assign_thread_id, project_thread_id),
         assignment_source = case
           when p_auto_assign_thread_id is not null then 'auto'::public.assignment_source
           else assignment_source
         end,
         processing_status = 'processed'
   where id = v_screenshot_id and user_id = v_user_id;

  update public.jobs
     set status = 'done', locked_at = null, locked_by = null, last_error = null
   where id = p_job_id;

  return true;
end;
$$;

create or replace function public.fail_process_capture_job(
  p_job_id bigint,
  p_worker_id text,
  p_error_code text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempts int;
  v_max_attempts int;
  v_screenshot_id uuid;
  v_delay interval;
begin
  if p_error_code !~ '^[a-z_]{1,64}$' then
    raise exception 'invalid worker error code' using errcode = '22023';
  end if;

  select j.attempts, j.max_attempts, s.id
    into v_attempts, v_max_attempts, v_screenshot_id
    from public.jobs as j
    join public.screenshots as s
      on s.id::text = j.payload ->> 'screenshot_id'
     and s.user_id = j.user_id
   where j.id = p_job_id
     and j.kind = 'process_capture'
     and j.status = 'processing'
     and j.locked_by = p_worker_id
   for update of j, s;

  if not found then
    raise exception 'worker does not own this job' using errcode = '55000';
  end if;

  if v_attempts >= v_max_attempts then
    update public.jobs
       set status = 'failed', locked_at = null, locked_by = null, last_error = p_error_code
     where id = p_job_id;
    update public.screenshots
       set processing_status = 'unprocessed'
     where id = v_screenshot_id and processing_status <> 'processed';
    return 'terminal';
  end if;

  v_delay := case v_attempts
    when 1 then interval '5 seconds'
    when 2 then interval '30 seconds'
    else interval '2 minutes'
  end;
  update public.jobs
     set status = 'pending',
         run_after = clock_timestamp() + v_delay,
         locked_at = null,
         locked_by = null,
         last_error = p_error_code
   where id = p_job_id;
  return 'retry_scheduled';
end;
$$;

revoke all on function public.claim_process_capture_job(text) from public, anon, authenticated;
revoke all on function public.complete_process_capture_job(bigint, text, jsonb, uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.fail_process_capture_job(bigint, text, text)
  from public, anon, authenticated;

grant execute on function public.claim_process_capture_job(text) to service_role;
grant execute on function public.complete_process_capture_job(bigint, text, jsonb, uuid, uuid, text)
  to service_role;
grant execute on function public.fail_process_capture_job(bigint, text, text) to service_role;
