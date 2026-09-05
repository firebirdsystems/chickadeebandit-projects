-- Projects: a household project (a renovation, a trip fund, a big purchase) with
-- a budget of estimated-vs-actual line items, a checklist with deadlines, and a
-- decisions log. Every table is prefixed app_projects__.
--
-- Encryption note: nothing here needs `db_plaintext_columns`. The columns this
-- app filters, sorts or CHECKs on are already plaintext to the codec — `status`
-- and `visibility` are built-in skips, `*_date`/`*_at`/`*_id`/`*_by` are skipped
-- by suffix, and numbers are never encrypted. Prose (`name`, `description`,
-- `label`, `title`, `body`, `vendor_name`) stays encrypted, which is why no
-- statement in this app compares it. A string CHECK on an encrypted column would
-- be a dead app: the stored value is ciphertext and never matches a literal.
CREATE TABLE IF NOT EXISTS app_projects__projects (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'planning'
                     CHECK (status IN ('planning', 'active', 'on_hold', 'done')),
  -- everyone: whole household. adults: any adult. private: the owner alone.
  visibility       TEXT NOT NULL DEFAULT 'adults'
                     CHECK (visibility IN ('everyone', 'adults', 'private')),
  target_date      TEXT,                      -- yyyy-mm-dd, household-local
  budget_cap_cents INTEGER,                   -- NULL = no cap declared
  file_ids         TEXT NOT NULL DEFAULT '[]',-- JSON array of hub file ids
  created_by       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  completed_at     TEXT,                      -- set when status becomes 'done'
  source_event_id  TEXT                       -- automation dedupe key
);

-- Line items. `estimated_cents` is what we thought; `actual_cents` is what it
-- came to, and stays NULL until it is really known — a 0 would read as free.
CREATE TABLE IF NOT EXISTS app_projects__budget_items (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES app_projects__projects(id) ON DELETE CASCADE,
  label           TEXT NOT NULL,
  vendor_name     TEXT NOT NULL DEFAULT '',
  estimated_cents INTEGER NOT NULL DEFAULT 0,
  actual_cents    INTEGER,
  purchased       INTEGER NOT NULL DEFAULT 0 CHECK (purchased IN (0, 1)),
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- Checklist and phase markers. A milestone is a checklist item that names a
-- moment rather than a chore ("Demo complete"), so it shares the table and the
-- date column instead of duplicating both.
CREATE TABLE IF NOT EXISTS app_projects__checklist_items (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES app_projects__projects(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  due_date     TEXT,                          -- yyyy-mm-dd, household-local
  assignee_id  TEXT,
  is_milestone INTEGER NOT NULL DEFAULT 0 CHECK (is_milestone IN (0, 1)),
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Ticking an item off is an act by whoever did it, not an edit of the item, so
-- it is its own row. `inherit_visibility` scopes UPDATE/DELETE on a child table
-- to the member who wrote it — there is no adult bypass and no knob to widen it
-- — so a `done_at` column ON the item could only ever be set by whoever created
-- the item, never by the person it was assigned to. A completion the ticker owns
-- is the shape the rest of the fleet uses for this (chore-tracker's
-- `completions`): anyone who can see the project may add their own, and only
-- they can take it back.
--
-- UNIQUE on item_id: an item is done or it is not. The row records WHO closed it.
CREATE TABLE IF NOT EXISTS app_projects__checklist_completions (
  id         TEXT PRIMARY KEY,
  -- The FK the row policy inherits from. It must point at `projects` (an
  -- `inherit_visibility` parent has to be an owner-bearing policy), so the
  -- project is denormalized here alongside the item it belongs to.
  project_id TEXT NOT NULL REFERENCES app_projects__projects(id) ON DELETE CASCADE,
  item_id    TEXT NOT NULL UNIQUE REFERENCES app_projects__checklist_items(id) ON DELETE CASCADE,
  done_by    TEXT NOT NULL,
  done_at    TEXT NOT NULL
);

-- The decisions log — "we picked the matte tile, model 4471" — which is the
-- thing a household actually loses between the quote and the install.
CREATE TABLE IF NOT EXISTS app_projects__notes (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES app_projects__projects(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Open projects first, then by the date they are aimed at: the preload's order.
CREATE INDEX IF NOT EXISTS app_projects__projects_open_idx
  ON app_projects__projects (completed_at, target_date);

-- Every child read is scoped to its parent, so the FK leads each index.
CREATE INDEX IF NOT EXISTS app_projects__budget_items_project_idx
  ON app_projects__budget_items (project_id, sort_order);

CREATE INDEX IF NOT EXISTS app_projects__checklist_items_project_idx
  ON app_projects__checklist_items (project_id, sort_order);

-- The agenda asks for "everything due today" across all projects, so due_date
-- leads here rather than project_id.
CREATE INDEX IF NOT EXISTS app_projects__checklist_items_due_idx
  ON app_projects__checklist_items (due_date);

-- Completions are read two ways: scoped to a project (the preload) and joined
-- to one item (the agenda's done flag, which the UNIQUE on item_id covers).
CREATE INDEX IF NOT EXISTS app_projects__checklist_completions_project_idx
  ON app_projects__checklist_completions (project_id);

CREATE INDEX IF NOT EXISTS app_projects__notes_project_idx
  ON app_projects__notes (project_id, created_at);
