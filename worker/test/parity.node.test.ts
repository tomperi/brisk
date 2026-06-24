import { afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { buildNodeApp, storageFromEnv } from '../src/platform/node/platform';
import { createFsStorage } from '../src/platform/node/storage-fs';
import { configFromEnv } from '../src/platform/node/config';
import { runHttpParity, runRealtimeParity } from './parity/suite';

let server: Server;
let dir = '';
let base = '';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'brisk-parity-'));
  const { app } = buildNodeApp({
    config: configFromEnv({ AUTH: 'none' } as NodeJS.ProcessEnv), // dev identity, like the worker tests
    dbPath: join(dir, 'brisk.sqlite'),
    migrationsDir: join(__dirname, '..', 'migrations'),
    assetsDir: join(__dirname, '..', 'assets'),
    storage: createFsStorage(join(dir, 'objects')),
  });
  const wss = new WebSocketServer({ noServer: true });
  await new Promise<void>((resolve) => {
    server = serve(
      { fetch: app.fetch, websocket: { server: wss }, port: 0, hostname: '127.0.0.1' },
      (info) => {
        base = `http://127.0.0.1:${info.port}`;
        resolve();
      },
    ) as Server;
  });
  void storageFromEnv; // referenced to keep the import meaningful; real entry uses it
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

runHttpParity(() => base);
runRealtimeParity(() => base);
