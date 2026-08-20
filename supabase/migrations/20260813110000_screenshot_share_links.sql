-- Private screenshot sharing. Source-only until explicitly approved for deploy.
-- Raw bearer tokens and raw passwords never enter Postgres.

create table public.screenshot_share_links (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users on delete cascade,
  screenshot_id       uuid not null,
  token_hash          text not null unique,
  password_hash       text,
  password_salt       text,
  password_iterations integer,
  storage_path        text not null,
  expires_at          timestamptz not null,
  one_time            boolean not null default false,
  consumed_at         timestamptz,
  revoked_at          timestamptz,
  view_count          integer not null default 0,
  created_at          timestamptz not null default now(),

  foreign key (screenshot_id, user_id)
    references public.screenshots (id, user_id)
    on delete cascade,
  constraint screenshot_share_token_hash_check
    check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint screenshot_share_password_pair_check
    check (
      (password_hash is null and password_salt is null and password_iterations is null)
      or
      (password_hash ~ '^[0-9a-f]{64}$' and password_salt ~ '^[A-Za-z0-9_-]{22}$'
        and password_iterations between 100000 and 1000000)
    ),
  constraint screenshot_share_storage_path_check
    check (storage_path ~ '^originals/[0-9a-f-]{36}/[0-9a-f-]{36}\.(png|jpg|jpeg|webp)$'),
  constraint screenshot_share_expiry_check
    check (expires_at > created_at and expires_at <= created_at + interval '31 days'),
  constraint screenshot_share_view_count_check
    check (view_count >= 0)
);

create index screenshot_share_owner_capture_idx
  on public.screenshot_share_links (user_id, screenshot_id, created_at desc);
create index screenshot_share_active_expiry_idx
  on public.screenshot_share_links (expires_at)
  where revoked_at is null;

alter table public.screenshot_share_links enable row level security;
revoke all privileges on table public.screenshot_share_links from public, anon, authenticated;
grant select, insert, update, delete on table public.screenshot_share_links to service_role;

create or replace function public.consume_screenshot_share(p_token_hash text)
returns table(storage_path text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_link public.screenshot_share_links%rowtype;
begin
  if p_token_hash !~ '^[0-9a-f]{64}$' then
    return;
  end if;

  select l.*
    into v_link
    from public.screenshot_share_links l
   where l.token_hash = p_token_hash
     and l.expires_at > now()
     and l.revoked_at is null
     and (not l.one_time or l.consumed_at is null)
   for update;

  if not found then
    return;
  end if;

  update public.screenshot_share_links
     set view_count = view_count + 1,
         consumed_at = case when v_link.one_time then now() else consumed_at end
   where id = v_link.id;

  return query select v_link.storage_path;
end;
$$;

revoke all on function public.consume_screenshot_share(text) from public, anon, authenticated;
grant execute on function public.consume_screenshot_share(text) to service_role;
