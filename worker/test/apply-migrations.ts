import { applyD1Migrations, env } from 'cloudflare:test';

// This setup file runs once per test file against storage shared across files
// (isolatedStorage: false). The pool's migration bookkeeping isn't reliable
// under that sharing, so a later file can try to re-apply migration 0001 onto
// an already-created schema and fail with "table sites already exists". A
// present schema is exactly the success state, so treat that re-apply as a
// no-op instead of letting the duplicate CREATE fail the whole file.
try {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
} catch (err) {
  if (!String((err as Error)?.message).includes('already exists')) throw err;
}
