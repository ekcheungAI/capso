-- The last gap between the client `Screenshot` type and this schema, found by
-- round-tripping every field in `apps/web/lib/store/map.check.ts`. Additive.
-- 10_DATA_MODEL.md §screenshots amended in the same commit per STOP rule 3.
--
-- `assignment_source` records *how* a capture reached its project: the model put
-- it there unattended (`auto`), the owner overrode the model (`user_corrected`),
-- the owner filed it from the Inbox (`inbox_triage`), or they moved it by hand
-- later (`manual`).
--
-- It is not derivable from `user_corrections`. A correction row says the value
-- changed and what it changed from; it does not say which surface the change
-- came from, and the acceptance-rate maths in /memory reads the two differently.
-- Null means "never assigned" — a capture still sitting in the Inbox.
create type assignment_source as enum (
  'auto', 'user_corrected', 'inbox_triage', 'manual'
);

alter table screenshots
  add column if not exists assignment_source assignment_source;
