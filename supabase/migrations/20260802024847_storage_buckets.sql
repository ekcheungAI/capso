-- Capso storage buckets (P1). Source of truth: 14_BACKEND_AND_STORAGE.md §1.
--
-- 0001 created every table the product needs and then nothing connected to it —
-- the app has been running entirely on browser IndexedDB, which a Mac app cannot
-- write to. These two buckets are the other half of that keystone: without a
-- destination for bytes, M1 (Mac capture) and M3 (upload pipeline) have nowhere
-- to put a capture.
--
-- Additive only: creates buckets and policies, touches no existing table. Safe to
-- re-run.

-- -------------------------------------------------------------- buckets ----
--
-- Both private, per 14 §1 — clients read through short-lived signed URLs, and
-- the AI worker hands a signed URL to the vision provider rather than making
-- anything public. `public = false` is the whole privacy posture in one column.
--
-- Size limits are guardrails, not product rules: a capture that exceeds them is
-- a bug (a runaway canvas export, a mis-scaled retina grab), and failing the
-- upload loudly beats silently storing a 60 MB PNG per screenshot.
--
-- allowed_mime_types deliberately admits jpeg and webp alongside png. 14 §1 says
-- "full-resolution PNG", but the shipped capture paths already downscale to JPEG
-- (apps/extension/background.js) and thumbs are WebP by spec. Pinning png here
-- would reject captures the product actually produces.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('originals', 'originals', false, 26214400, -- 25 MiB
    array['image/png', 'image/jpeg', 'image/webp']),
  ('thumbs',    'thumbs',    false,  2097152, -- 2 MiB; an 800px q80 webp is ~50-150 KB
    array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;

-- ------------------------------------------------------------ storage RLS ----
--
-- "Storage RLS policies mirror DB RLS: path must start with auth.uid()" (14 §1).
-- Object keys are `user_id/screenshot_id.ext`, so the first path segment is the
-- owner and `storage.foldername(name)[1]` is that segment.
--
-- Scoped `to authenticated` to match the table policies in 0001. Anonymous
-- Supabase sessions carry the `authenticated` role and a real auth.uid(), so
-- demo visitors are isolated from each other by exactly the same rule that will
-- isolate real accounts later — the anonymous-session decision needs no separate
-- policy and no schema change.
--
-- `for all` rather than separate select/insert/update/delete policies: the owner
-- may do anything within their own prefix and nothing outside it, and splitting
-- that into four policies is four places for the prefix check to drift apart.
do $$
declare b text;
begin
  foreach b in array array['originals', 'thumbs'] loop
    -- Idempotent: re-running the migration must not error on an existing policy.
    execute format('drop policy if exists %I on storage.objects', b || '_owner');
    execute format(
      'create policy %I on storage.objects for all to authenticated
         using (bucket_id = %L and (storage.foldername(name))[1] = auth.uid()::text)
         with check (bucket_id = %L and (storage.foldername(name))[1] = auth.uid()::text)',
      b || '_owner', b, b
    );
  end loop;
end $$;
