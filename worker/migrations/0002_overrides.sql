-- Phase 2: the current approved state of edited / added buildings, and the published overlay tiles.

-- One row per building that differs from the OpenStreetMap data.
CREATE TABLE overrides (
  ref           TEXT    PRIMARY KEY,         -- way:<osm id> | new:<n>
  osm_id        INTEGER,                     -- the OSM way it replaces (NULL for a new building)
  feature_id    REAL    NOT NULL,            -- id drawn in the tiles: the OSM way id, or −n for a new building
  footprint     TEXT    NOT NULL,            -- JSON [[lng, lat], …], open ring
  height        REAL,                        -- meters, wins over building:levels
  levels        INTEGER,
  building_type TEXT,
  name          TEXT,                        -- English
  base_tags     TEXT,                        -- JSON: the OSM tags of the original (kept, merged with the edit)
  hide_tile     TEXT,                        -- z14 "x/y" whose tile builds the original way (first vertex)
  owner_tile    TEXT    NOT NULL,            -- z14 "x/y" whose tile builds the edited footprint
  updated_by    INTEGER REFERENCES users(github_id),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX overrides_hide ON overrides(hide_tile);
CREATE INDEX overrides_owner ON overrides(owner_tile);

-- Ids for new buildings (feature_id = −n).
CREATE TABLE new_buildings (n INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));

-- Published overlay tiles (R2 overlay/14/x/y.json) and the revision each was last written at.
CREATE TABLE overlay_tiles (tile TEXT PRIMARY KEY, rev INTEGER NOT NULL);
CREATE TABLE overlay_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
INSERT INTO overlay_meta (k, v) VALUES ('rev', 0);
