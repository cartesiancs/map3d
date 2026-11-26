-- Phase 1: accounts, sessions, audit log. Contributions and overrides come with phase 2-3 migrations.

CREATE TABLE users (
  github_id         INTEGER PRIMARY KEY,         -- numeric GitHub user id (stable, unlike the login)
  login             TEXT    NOT NULL,
  avatar_url        TEXT,
  github_created_at TEXT,                        -- GitHub account age, for rate limits on new accounts later
  banned            INTEGER NOT NULL DEFAULT 0,
  accepted_terms_at TEXT,                        -- ODbL agreement, asked on the first contribution
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_login_at     TEXT
);

-- The cookie holds a random token; only its SHA-256 is stored, so a database leak does not leak sessions.
CREATE TABLE sessions (
  id_hash    TEXT    PRIMARY KEY,
  github_id  INTEGER NOT NULL REFERENCES users(github_id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT    NOT NULL
);
CREATE INDEX sessions_user ON sessions(github_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE audit_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER,                              -- github_id, NULL for anonymous
  action   TEXT    NOT NULL,                     -- login | logout | login_denied | ...
  target   TEXT,
  detail   TEXT,                                 -- JSON
  at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX audit_actor ON audit_log(actor_id, at);
