-- Exact column-order coverage for the composite owner foreign keys. Prefix
-- indexes helped ordinary product reads but still left referential actions
-- doing extra filtering according to the hosted database advisor.
create index conversation_messages_thread_owner_idx
  on public.conversation_messages (project_thread_id, user_id);

create index jobs_user_idx
  on public.jobs (user_id);

create index revisit_events_screenshot_owner_idx
  on public.revisit_events (screenshot_id, user_id);

create index screenshots_thread_owner_idx
  on public.screenshots (project_thread_id, user_id);
