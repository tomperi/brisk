import { serve, type ServerType } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFromEnv } from './platform/node/config';
import { buildNodeApp, storageFromEnv } from './platform/node/platform';

const here = dirname(fileURLToPath(import.meta.url));
// Compiled layout: dist/index.node.js with assets + migrations resolved relative
// to the package root. Adjust these two if the build output differs.
const ASSETS_DIR = process.env.ASSETS_DIR ?? join(here, '..', 'assets');
const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? join(here, '..', 'migrations');

const { app, rooms } = buildNodeApp({
  config: configFromEnv(),
  dbPath: process.env.SQLITE_PATH ?? '/data/brisk.sqlite',
  migrationsDir: MIGRATIONS_DIR,
  assetsDir: ASSETS_DIR,
  storage: storageFromEnv(),
});

const wss = new WebSocketServer({ noServer: true });
const port = Number(process.env.PORT ?? 8787);
const server: ServerType = serve(
  { fetch: app.fetch, websocket: { server: wss }, port, hostname: '0.0.0.0' },
  (info) => console.log(`brisk(node) listening on http://${info.address}:${info.port}`),
);
void rooms; // rooms fan-out is wired via app's wsRoute + the websocket server

const shutdown = (): void => {
  server.closeIdleConnections?.();
  setTimeout(() => server.closeAllConnections?.(), 10_000).unref();
  server.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
