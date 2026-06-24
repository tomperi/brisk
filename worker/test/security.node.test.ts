import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { buildNodeApp } from '../src/platform/node/platform';
import { createFsStorage } from '../src/platform/node/storage-fs';
import { configFromEnv } from '../src/platform/node/config';
import type { Env } from '../src/env';

// The parity suite boots with AUTH=none. These security-critical Node paths —
// the visitor gate under AUTH=google+VISIBILITY=public, and the fail-closed
// (503) when AUTH is unset on a non-local Host — have no other automated Node
// coverage, so a regression in how @hono/node-server routes through the auth
// middleware (or in c.req.url host derivation) would silently weaken auth.

const ASSETS_DIR = join(__dirname, '..', 'assets');
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

function boot(
  env: Partial<NodeJS.ProcessEnv>,
): Promise<{ base: string; close: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'brisk-sec-'));
  const { app } = buildNodeApp({
    config: configFromEnv(env as NodeJS.ProcessEnv),
    dbPath: join(dir, 'brisk.sqlite'),
    migrationsDir: MIGRATIONS_DIR,
    assetsDir: ASSETS_DIR,
    storage: createFsStorage(join(dir, 'objects')),
  });
  const wss = new WebSocketServer({ noServer: true });
  return new Promise((resolve) => {
    const server = serve(
      { fetch: app.fetch, websocket: { server: wss }, port: 0, hostname: '127.0.0.1' },
      (info) => {
        const base = `http://127.0.0.1:${info.port}`;
        resolve({
          base,
          close: async () => {
            (server as Server).closeAllConnections?.();
            await new Promise<void>((r) => (server as Server).close(() => r()));
            rmSync(dir, { recursive: true, force: true });
          },
        });
      },
    );
  });
}

describe('node security: visitor gate (AUTH=google, VISIBILITY=public)', () => {
  let srv: { base: string; close: () => Promise<void> };
  beforeAll(async () => {
    srv = await boot({
      AUTH: 'google',
      VISIBILITY: 'public',
      SESSION_SECRET: 'test-secret',
    } satisfies Partial<Env> as Partial<NodeJS.ProcessEnv>);
  });
  afterAll(() => srv.close());

  it('blocks an anonymous visitor on a write API (401)', async () => {
    const res = await fetch(`${srv.base}/api/db/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-brisk-site': 'sec' },
      body: JSON.stringify({ text: 'nope' }),
    });
    expect(res.status).toBe(401);
  });

  it('allows the one visitor API exception (GET /api/sites → 200)', async () => {
    const res = await fetch(`${srv.base}/api/sites`);
    expect(res.status).toBe(200);
  });

  it('does not open a visitor websocket upgrade', async () => {
    const ws = new WebSocket(`${srv.base.replace(/^http/, 'ws')}/api/ws?site=sec`);
    const outcome = await new Promise<'open' | 'closed'>((resolve) => {
      const t = setTimeout(() => resolve('closed'), 1500);
      ws.addEventListener('open', () => {
        clearTimeout(t);
        resolve('open');
      });
      ws.addEventListener('error', () => {
        clearTimeout(t);
        resolve('closed');
      });
    });
    try {
      ws.close();
    } catch {
      // already closed
    }
    expect(outcome).toBe('closed');
  });
});

describe('node security: fail closed when AUTH is unset on a public host', () => {
  let srv: { base: string; close: () => Promise<void> };
  let port = 0;
  beforeAll(async () => {
    srv = await boot({}); // AUTH unset
    port = Number(new URL(srv.base).port);
  });
  afterAll(() => srv.close());

  // undici's fetch strips a spoofed Host header, so issue a raw HTTP/1.1
  // request with a non-local Host to exercise the fail-closed branch.
  it('returns 503 for a non-local Host header', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const sock = connect(port, '127.0.0.1', () => {
        sock.write('GET /api/me HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n');
      });
      let buf = '';
      sock.on('data', (d) => (buf += d.toString()));
      sock.on('end', () => {
        const m = buf.match(/^HTTP\/1\.1 (\d{3})/);
        m ? resolve(Number(m[1])) : reject(new Error(`no status line: ${buf.slice(0, 80)}`));
      });
      sock.on('error', reject);
      setTimeout(() => reject(new Error('raw request timeout')), 2000);
    });
    expect(status).toBe(503);
  });

  it('serves locally (127.0.0.1 Host) as the dev identity', async () => {
    const res = await fetch(`${srv.base}/api/me`);
    expect(res.status).toBe(200);
  });
});
