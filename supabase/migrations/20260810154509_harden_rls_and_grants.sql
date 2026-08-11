-- Tighten the browser-facing Data API before the first permanent account writes
-- data. The hosted project is empty at deployment time, so replacing foreign
-- keys here has no lock-heavy validation or backfill cost.

-- Supabase's RLS auto-enable event trigger is useful, but the trigger function
-- itself is not a client RPC. Hosted projects include it; local stacks may not.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end;
$$;

-- Default platform grants include privileges the browser never needs, including
-- TRUNCATE (which RLS does not protect). Keep only the four CRUD operations used
-- by the current Supabase-backed store, and expose nothing to the anon role.
revoke all privileges on table
  public.project_threads,
  public.screenshots,
  public.user_corrections,
  public.revisit_events,
  public.conversation_messages
from anon, authenticated;

grant select, insert, update, delete on table
  public.project_threads,
  public.screenshots,
  public.user_corrections,
  public.revisit_events,
  public.conversation_messages
to authenticated;

-- Cache auth.uid() once per statement instead of recalculating it per row.
drop policy if exists project_threads_owner on public.project_threads;
create policy project_threads_owner on public.project_threads
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists screenshots_owner on public.screenshots;
create policy screenshots_owner on public.screenshots
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists user_corrections_owner on public.user_corrections;
create policy user_corrections_owner on public.user_corrections
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists revisit_events_owner on public.revisit_events;
create policy revisit_events_owner on public.revisit_events
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists conversation_messages_owner on public.conversation_messages;
create policy conversation_messages_owner on public.conversation_messages
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- A row may only point at another row owned by the same account. RLS alone
-- hides foreign rows but does not stop a guessed UUID from being referenced.
create unique index project_threads_id_user_idx
  on public.project_threads (id, user_id);
create unique index screenshots_id_user_idx
  on public.screenshots (id, user_id);

alter table public.screenshots
  drop constraint if exists screenshots_project_thread_id_fkey,
  drop constraint if exists screenshots_suggested_thread_id_fkey,
  add constraint screenshots_project_thread_owner_fkey
    foreign key (project_thread_id, user_id)
    references public.project_threads (id, user_id)
    on delete set null (project_thread_id),
  add constraint screenshots_suggested_thread_owner_fkey
    foreign key (suggested_thread_id, user_id)
    references public.project_threads (id, user_id)
    on delete set null (suggested_thread_id);

alter table public.conversation_messages
  drop constraint if exists conversation_messages_project_thread_id_fkey,
  add constraint conversation_messages_project_thread_owner_fkey
    foreign key (project_thread_id, user_id)
    references public.project_threads (id, user_id)
    on delete cascade;

alter table public.user_corrections
  drop constraint if exists user_corrections_screenshot_id_fkey,
  add constraint user_corrections_screenshot_owner_fkey
    foreign key (screenshot_id, user_id)
    references public.screenshots (id, user_id)
    on delete cascade;

alter table public.revisit_events
  drop constraint if exists revisit_events_screenshot_id_fkey,
  add constraint revisit_events_screenshot_owner_fkey
    foreign key (screenshot_id, user_id)
    references public.screenshots (id, user_id)
    on delete cascade;

-- Cover the lookup side of every newly hardened foreign key and the advisor's
-- original user-id findings.
create index conversation_messages_user_idx
  on public.conversation_messages (user_id);
create index revisit_events_user_idx
  on public.revisit_events (user_id);
create index screenshots_suggested_thread_idx
  on public.screenshots (suggested_thread_id, user_id);
create index user_corrections_screenshot_idx
  on public.user_corrections (screenshot_id, user_id);
