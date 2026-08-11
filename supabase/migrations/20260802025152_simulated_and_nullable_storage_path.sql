-- Two corrections found while porting the IndexedDB store onto this schema
-- (P1 keystone). Both are additive or loosening — no data is dropped, and the
-- table is empty at time of writing. Source of truth: 10_DATA_MODEL.md
-- §screenshots, amended in the same commit per STOP rule 3.

-- ------------------------------------------------------------ simulated ----
--
-- The client type has carried `simulated` since the demo track began and there
-- was never a column for it. It is not cosmetic: it marks a capture whose
-- metadata came from canned demo output rather than the model (no API key
-- configured). Without it a demo capture is indistinguishable from a real one
-- the moment it is written, and its *invented* ocr_text goes straight into the
-- search index — the exact bug the flag was added to fix.
--
-- Defaults false: every row that could exist before this column is by definition
-- a real capture.
alter table screenshots
  add column if not exists simulated boolean not null default false;

-- --------------------------------------------------- storage_path is null ----
--
-- 0001 declared `storage_path text not null`, which assumes a row is only ever
-- written *after* its bytes land in Storage. Two shipped behaviours contradict
-- that:
--
--   1. M3's upload pipeline is explicitly "capture → local queue → Storage + row"
--      and must survive offline (04 Table 1). A queued capture is a real row
--      whose bytes have not been uploaded yet; forcing a path would mean either
--      blocking capture on the network or writing a lie.
--   2. Seeded sample fixtures have no image at all — they draw a deterministic
--      placeholder — so there is no object to point at.
--
-- Null therefore means "no bytes in Storage (yet)", which the UI already handles:
-- it falls back to the placeholder renderer. Loosening a constraint on an empty
-- table is non-destructive and reversible.
alter table screenshots
  alter column storage_path drop not null;
