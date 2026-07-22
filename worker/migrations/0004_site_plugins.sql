-- Which plugins a site opted into, resolved against the registry at deploy time
-- and stored as a JSON array of plugin ids. NULL/absent = none (legacy rows).
ALTER TABLE sites ADD COLUMN plugins TEXT;
