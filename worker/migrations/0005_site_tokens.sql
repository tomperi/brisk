-- Site tokens: long-lived bearer credentials limited to named sites and scopes,
-- for CI and scripts. Only the SHA-256 of the secret is stored.
CREATE TABLE tokens (
  id TEXT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  sites TEXT NOT NULL,              -- JSON array of exact site names
  scopes TEXT NOT NULL,             -- JSON array of read | write | update | delete
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  last_used_at TEXT
);
