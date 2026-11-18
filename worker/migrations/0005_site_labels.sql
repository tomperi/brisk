-- Free-form tags a site carries on the dashboard, as a JSON array of slugs.
-- NULL/absent = none. Set by deploys that send labels; others leave it alone.
ALTER TABLE sites ADD COLUMN labels TEXT;
