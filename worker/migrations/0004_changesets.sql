-- Phase 4: Edit mode. Several buildings are proposed together as one changeset, reviewed all or nothing;
-- buildings can be free 3D meshes, and approved edits can remove a building.

-- One proposal: a comment and the buildings it changes (changeset_items).
CREATE TABLE changesets (
  id            TEXT    PRIMARY KEY,                -- random id
  author_id     INTEGER NOT NULL REFERENCES users(github_id),
  comment       TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn', 'conflict')),
  superseded_by TEXT,                               -- the changeset that replaced it ("Edit my proposal")
  reviewer_id   INTEGER,
  review_note   TEXT,
  lng           REAL    NOT NULL,                   -- center of the changed buildings (review camera)
  lat           REAL    NOT NULL,
  bbox          TEXT    NOT NULL,                   -- JSON [west, south, east, north]
  item_count    INTEGER NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  reviewed_at   TEXT
);
CREATE INDEX changesets_status ON changesets(status, created_at);
CREATE INDEX changesets_author ON changesets(author_id, created_at);

-- One building of a changeset.
CREATE TABLE changeset_items (
  changeset_id TEXT    NOT NULL REFERENCES changesets(id),
  seq          INTEGER NOT NULL,                    -- order in the changeset
  building_ref TEXT,                                -- way:<id> | new:<n>; NULL for a new building until approved
  client_id    TEXT,                                -- the app's id for a new building (drafts)
  kind         TEXT    NOT NULL CHECK (kind IN ('modify', 'create', 'delete')),
  proposal     TEXT    NOT NULL,                    -- JSON: the changed fields (footprint, height, levels or mesh)
  base         TEXT,                                -- JSON { footprint, tags }: the OSM building when editing started
  base_rev     TEXT    NOT NULL,                    -- overrides.updated_at then, 'osm', or 'new' (conflict check)
  PRIMARY KEY (changeset_id, seq)
);
CREATE INDEX changeset_items_ref ON changeset_items(building_ref);

-- a free 3D shape (src/contrib/mesh.ts wire format; NULL: the footprint extruded to `height`), and removal
ALTER TABLE overrides ADD COLUMN mesh TEXT;
ALTER TABLE overrides ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;

-- Earlier single-building contributions become one-building changesets with the same id (overrides.contribution_id
-- keeps pointing at them). The contributions table stays as history.
INSERT INTO changesets (id, author_id, comment, status, reviewer_id, review_note, lng, lat, bbox, item_count, created_at, reviewed_at)
  SELECT id, author_id, comment, status, reviewer_id, review_note, lng, lat, json_array(lng, lat, lng, lat), 1, created_at, reviewed_at
  FROM contributions;
INSERT INTO changeset_items (changeset_id, seq, building_ref, client_id, kind, proposal, base, base_rev)
  SELECT id, 0, building_ref, NULL, kind, proposal, base, base_rev FROM contributions;
