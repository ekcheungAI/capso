-- Processing may suggest a project, but it must never replace a destination the
-- owner already chose at capture time or during triage. The earlier completion
-- function unconditionally preferred p_auto_assign_thread_id, which made a
-- manual extension destination look saved and then silently move after AI ran.

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
     and p_auto_assign_thread_id is distinct from p_suggested_thread_id then
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
         project_thread_id = case
           when assignment_source is null then coalesce(p_auto_assign_thread_id, project_thread_id)
           else project_thread_id
         end,
         assignment_source = case
           when assignment_source is null and p_auto_assign_thread_id is not null
             then 'auto'::public.assignment_source
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

revoke all on function public.complete_process_capture_job(bigint, text, jsonb, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.complete_process_capture_job(bigint, text, jsonb, uuid, uuid, text)
  to service_role;
