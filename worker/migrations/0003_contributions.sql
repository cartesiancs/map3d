-- Phase 3: contributions (proposals) and the admin review queue. An approved contribution becomes an override.

CREATE TABLE contributions (
  id           TEXT    PRIMARY KEY,                  -- random id
  building_ref TEXT,                                 -- way:<id> | new:<n>; NULL for a new building until approved
  kind         TEXT    NOT NULL CHECK (kind IN ('modify', 'create')),
  proposal     TEXT    NOT NULL,                     -- JSON: the changed fields only (BuildingEdit, partial)
  base         TEXT,                                 -- JSON { footprint, tags }: the building when editing started
  base_rev     TEXT    NOT NULL,                     -- overrides.updated_at at that time, or 'osm' (conflict check)
  comment      TEXT    NOT NULL,
  author_id    INTEGER NOT NULL REFERENCES users(github_id),
  status       TEXT    NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn', 'conflict')),
  reviewer_id  INTEGER,
  review_note  TEXT,
  lng          REAL    NOT NULL,                     -- where the building is (review camera)
  lat          REAL    NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  reviewed_at  TEXT
);
CREATE INDEX contributions_status ON contributions(status, created_at);
CREATE INDEX contributions_ref ON contributions(building_ref);
CREATE INDEX contributions_author ON contributions(author_id, created_at);

-- the contribution an override came from (NULL: written directly by an admin)
ALTER TABLE overrides ADD COLUMN contribution_id TEXT;
