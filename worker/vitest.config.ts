import path from 'node:path';
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, 'migrations'));
  return {
    test: {
      include: ['test/**/*.test.ts'],
      exclude: ['test/**/*.node.test.ts', 'node_modules/**'],
      setupFiles: ['./test/apply-migrations.ts'],
      poolOptions: {
        workers: {
          // caches.default writes (the visitor edge cache) break per-test
          // storage snapshots; tests use unique site names instead.
          isolatedStorage: false,
          wrangler: { configPath: './wrangler.jsonc' },
          miniflare: {
            // Tests pin their own auth mode so production config in
            // wrangler.jsonc (AUTH, VISIBILITY, allowlists) can't break them.
            bindings: {
              TEST_MIGRATIONS: migrations,
              AUTH: 'none',
              VISIBILITY: 'private',
              BASE_HOST: '',
              ALLOWED_EMAILS: '',
              ALLOWED_EMAIL_DOMAINS: '',
            },
          },
        },
      },
    },
  };
});
