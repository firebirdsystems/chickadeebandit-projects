-- Small copies of a project's photos, for the photo grid.
--
-- `photo_thumbs` is a JSON object that maps a photo's file id to the file id of
-- its small copy: {"<photo id>": "<small copy id>"}. A photo with no small copy
-- has no entry. A row from before this column has `{}`, and the grid draws the
-- photo itself.
--
-- The column is not named like a file column and is not declared in any
-- manifest file key. A declared file-list column holds a flat JSON array of
-- ids, which cannot say which photo a copy belongs to, so the photos stay in
-- `file_ids` (declared) and the copies are looked up here. A small copy belongs
-- to its photo: when a photo's id leaves `file_ids` (the project is deleted, or
-- the list is rewritten), the hub deletes the photo and every copy made from it
-- that no declared column names. An entry left behind in this object is
-- harmless, because the app only looks one up by an id that is still in the
-- list.

ALTER TABLE app_projects__projects ADD COLUMN photo_thumbs TEXT NOT NULL DEFAULT '{}';
