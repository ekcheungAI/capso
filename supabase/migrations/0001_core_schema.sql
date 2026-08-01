-- Capso core schema (P1). Source of truth: 10_DATA_MODEL.md.
--
-- Not applied yet: creating the Supabase project is an owner decision (STOP
-- rules 3+4 in 20_AGENT_LOOP_INSTRUCTIONS.md). Apply with the Supabase CLI or
-- the MCP `apply_migration` tool once the project exists.
--
-- Two deliberate departures from 10_DATA_MODEL.md, both documented below:
--   1. `search_tsv` uses the `simple` config over a pre-segmented column, not
--      `english` over raw text — see §Full-text search.
--   2. Tagging columns (`tags`, `user_tags`) and capture context (`page_url`,
--      `page_title`) are new; the doc predates both.

create extension if not exists vector;

-- ---------------------------------------------------------------- enums ----

create type capture_kind as enum ('screenshot', 'link', 'file');
create type processing_status as enum ('pending', 'processing', 'processed', 'unprocessed');
create type capture_intent as enum (
  'design_inspiration', 'ux_bug', 'competitor',
  'marketing_hook', 'content_idea', 'reference', 'other'
);
create type correction_field as enum ('project', 'intent', 'why_saved', 'tags');
create type revisit_kind as enum ('opened_detail', 'referenced_in_chat', 'copied', 'search_clicked');
create type message_role as enum ('user', 'assistant', 'system', 'tool');

-- OCR provenance. Reserved by 06 §2 so replacing the engine is not a migration:
-- `llm` is the model transcribing inside the classify call, `tesseract` is the
-- browser OCR pass, `apple_vision` is the Mac app's on-device pass.
create type ocr_source as enum ('llm', 'tesseract', 'apple_vision');

-- ------------------------------------------------------------- threads ----

create table project_threads (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users on delete cascade,
  name          text not null,
  -- Doubles as the classifier's candidate context (06 §8). A bare name makes
  -- the model guess from a label, so this is not decoration.
  description   text not null default '',
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  last_active_at timestamptz not null default now()
);

create index project_threads_user_active_idx
  on project_threads (user_id, last_active_at desc);

-- --------------------------------------------------------- screenshots ----

create table screenshots (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users on delete cascade,
  project_thread_id uuid references project_threads on delete set null,
  capture_kind      capture_kind not null default 'screenshot',

  storage_path      text not null,
  thumb_path        text,
  width             int,
  height            int,
  bytes             bigint,

  source            text,
  source_app        text,
  -- Capture context. The extension has always sent these; before this migration
  -- there was nowhere to put them.
  page_url          text,
  page_title        text,

  processing_status processing_status not null default 'pending',

  title             text not null default '',
  summary           text not null default '',
  why_saved         text not null default '',
  ocr_text          text not null default '',
  ocr_source        ocr_source,
  ocr_langs         text[] not null default '{}',
  type              text,
  intent            capture_intent,

  -- Two tag lists, never merged: `tags` is what the model proposed, `user_tags`
  -- is what the owner typed. Collapsing them would erase who said what, and the
  -- whole correction ledger depends on that distinction.
  tags              text[] not null default '{}',
  user_tags         text[] not null default '{}',

  confidence        real not null default 0,
  suggested_thread_id uuid references project_threads on delete set null,

  -- Exact-duplicate detection at ingest, replacing a title-word heuristic.
  content_hash      text,
  embedding         vector(1536),

  archived          boolean not null default false,
  captured_at       timestamptz not null,
  created_at        timestamptz not null default now(),

  -- §Full-text search ------------------------------------------------------
  -- Hosted Supabase has no `zhparser`, and the `english` config treats a run of
  -- Han characters as one token — so "定價" never matches a document containing
  -- "定價頁面". The client segments text with Intl.Segmenter (lib/retrieve.ts)
  -- and writes the space-joined result here; `simple` then indexes those tokens
  -- verbatim. English loses stemming, which the trailing raw text restores well
  -- enough at personal corpus size.
  search_text       text not null default '',
  search_tsv        tsvector generated always as (
                      to_tsvector('simple', search_text)
                    ) stored
);

create index screenshots_user_captured_idx on screenshots (user_id, captured_at desc);
create index screenshots_thread_captured_idx on screenshots (project_thread_id, captured_at desc);
create index screenshots_search_idx on screenshots using gin (search_tsv);
create index screenshots_tags_idx on screenshots using gin (tags);
create index screenshots_user_tags_idx on screenshots using gin (user_tags);
create index screenshots_content_hash_idx on screenshots (user_id, content_hash)
  where content_hash is not null;
-- Worker queue + the "unprocessed" badge only ever look at unfinished rows.
create index screenshots_pending_idx on screenshots (user_id, processing_status)
  where processing_status <> 'processed';

-- HNSW over ivfflat: no training step, better recall, and fine at the row
-- counts a personal corpus reaches (08 §Assumptions).
create index screenshots_embedding_idx on screenshots
  using hnsw (embedding vector_cosine_ops);

-- --------------------------------------------------------- corrections ----

create table user_corrections (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users on delete cascade,
  screenshot_id uuid not null references screenshots on delete cascade,
  field         correction_field not null,
  ai_value      text,
  user_value    text not null default '',
  -- Accepts are recorded as well as overrides: acceptance rate is
  -- accepted ÷ (accepted + overridden), so both halves have to exist.
  was_ai_accepted boolean not null default false,
  created_at    timestamptz not null default now()
);

-- The few-shot window is "the most recent N", so this index is the hot path.
create index user_corrections_recent_idx on user_corrections (user_id, created_at desc);

create table revisit_events (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users on delete cascade,
  screenshot_id uuid not null references screenshots on delete cascade,
  kind          revisit_kind not null,
  created_at    timestamptz not null default now()
);

create index revisit_events_screenshot_idx on revisit_events (screenshot_id, created_at desc);

create table conversation_messages (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users on delete cascade,
  project_thread_id uuid not null references project_threads on delete cascade,
  role              message_role not null,
  content           text not null,
  -- What the answer claims to have read, validated against what was actually
  -- supplied before it is stored.
  cited_screenshot_ids uuid[] not null default '{}',
  created_at        timestamptz not null default now()
);

create index conversation_messages_thread_idx
  on conversation_messages (project_thread_id, created_at);

-- ---------------------------------------------------------------- RLS -----

-- Enabled on every table even though MVP is single-user: this is what makes
-- multi-tenant a config change rather than a migration (10 §RLS).
alter table project_threads      enable row level security;
alter table screenshots          enable row level security;
alter table user_corrections     enable row level security;
alter table revisit_events       enable row level security;
alter table conversation_messages enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'project_threads', 'screenshots', 'user_corrections',
    'revisit_events', 'conversation_messages'
  ] loop
    execute format(
      'create policy %I_owner on %I for all to authenticated
         using (user_id = auth.uid()) with check (user_id = auth.uid())',
      t, t
    );
  end loop;
end $$;
