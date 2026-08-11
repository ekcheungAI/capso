-- Supabase's linter flags extensions living in `public`. Doing this while
-- `screenshots` is still empty is free; doing it later means an index rebuild.
create schema if not exists extensions;
alter extension vector set schema extensions;
