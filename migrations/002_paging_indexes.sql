-- Composite indexes covering the child tabs' keyset paging.
--
-- Each child read resumes after the last row it holds, ordered by the table's
-- full display key with `id` appended as a tiebreaker. The original indexes
-- stopped at the first ordering column, so SQLite could seek to the project but
-- then had to sort every one of its rows in a temporary B-tree — for tables
-- that permit 20,000 rows each. Extending them to the complete ordering removes
-- the sort entirely (verified with EXPLAIN QUERY PLAN: "USE TEMP B-TREE FOR
-- LAST 2 TERMS OF ORDER BY" disappears).
--
-- The old indexes are dropped rather than left in place: each is now a strict
-- prefix of its replacement, so keeping both would pay for two index writes per
-- row insert and buy nothing. The names are reused so the schema reads the same.
--
-- `notes` is indexed DESC on created_at to match its read order (newest first);
-- the `id` tiebreaker stays ascending, because it breaks ties within the
-- primary sort rather than participating in it.

DROP INDEX IF EXISTS app_projects__budget_items_project_idx;

CREATE INDEX IF NOT EXISTS app_projects__budget_items_project_idx
  ON app_projects__budget_items (project_id, sort_order, created_at, id);

DROP INDEX IF EXISTS app_projects__checklist_items_project_idx;

CREATE INDEX IF NOT EXISTS app_projects__checklist_items_project_idx
  ON app_projects__checklist_items (project_id, sort_order, created_at, id);

DROP INDEX IF EXISTS app_projects__notes_project_idx;

CREATE INDEX IF NOT EXISTS app_projects__notes_project_idx
  ON app_projects__notes (project_id, created_at DESC, id);
