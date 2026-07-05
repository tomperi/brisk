-- Every publish is retained as an immutable versioned row here; deploys are no
-- longer deleted after a pointer swap. Serving is unchanged: sites.active_deploy
-- still names the single live deploy. This is groundwork for rollback/history —
-- nothing consumes these rows yet.
CREATE TABLE deploys (
  site TEXT NOT NULL,
  deploy TEXT NOT NULL,          -- R2 prefix id; equals sites.active_deploy while live
  version INTEGER NOT NULL,      -- monotonic per site, starting at 1
  files INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT,
  PRIMARY KEY (site, deploy)
);

CREATE UNIQUE INDEX deploys_site_version ON deploys (site, version);
