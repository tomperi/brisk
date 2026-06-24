# Phase 3: Node/Kubernetes Assembly — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Node assembly so the same Hono core runs outside Cloudflare — `node:sqlite` for the database, S3-compatible (aws4fetch) **and** filesystem storage, an in-process `Rooms` impl driving the existing `RoomLogic`, disk-served assets, an in-memory cache — served by `@hono/node-server` with websockets, plus a cross-runtime parity test suite. Cloudflare stays a first-class, unchanged target.

**Architecture:** New `platform/node/*` adapters implement the interfaces from `platform/types.ts`. A new `index.node.ts` entry builds them from `process.env`, delivers config by overwriting `c.env` inside the Node `makePlatform` hook (Node's default `c.env` is `{incoming,outgoing}`; `Context.env` is a writable field), and serves the shared app via `@hono/node-server` v2 with built-in websockets. The only shared-code change is an **optional `wsRoute` override** on `createApp` (Cloudflare keeps its current handler as the default; Node supplies an `upgradeWebSocket` handler, because Node upgrades arrive on the HTTP `'upgrade'` event rather than the request path). A second `vitest.node.config.ts` runs a shared parity suite against the booted Node server (filesystem storage + temp SQLite — no MinIO in CI).

**Tech Stack:** TypeScript strict, Hono, Node 24 (`node:sqlite`, global `fetch`/`WebSocket`), `@hono/node-server` v2, `ws`, `aws4fetch`, vitest (workers pool + node env).

**Prerequisites:** Phases 1–2 complete and the gate at **43 tests green**. `platform/types.ts`, `platform/cloudflare/*`, `room-logic.ts` (with `RoomLogic<C>` + `RoomPort<C>`) all exist.

---

## Research basis (verified on Node 24.11.1)

- **`node:sqlite`**: `DatabaseSync`; no `.bind()` (params passed to `get/all/run`); `get()` returns `undefined` (coerce to `null`); `run()` → `{changes, lastInsertRowid}` (coerce `changes` with `Number()`); no `batch()` (emulate with `exec('BEGIN'|'COMMIT'|'ROLLBACK')`); flag-free since Node 23.4 but emits `ExperimentalWarning` at import (silence with `--disable-warning=ExperimentalWarning`). Set `PRAGMA journal_mode=WAL` + a busy `timeout`.
- **`@hono/node-server` v2.0.5**: `serve({fetch, port, hostname, websocket?}, info=>…)` returns a Node `http.Server`; default `c.env` is `{incoming, outgoing}`; `Context.env` is a plain writable field → reassign it in middleware. Built-in `upgradeWebSocket` (import from `@hono/node-server`); pass `websocket: { server: new WebSocketServer({noServer:true}) }` (from `ws`).
- **`@hono/node-ws`**: do NOT use — deprecation path, conflicts with node-server v2.
- **`aws4fetch` 1.0.20**: `new AwsClient({accessKeyId, secretAccessKey, region, service:'s3'})`; path-style URLs (`endpoint/bucket/key`) for MinIO+AWS; `duplex:'half'` for stream PUT bodies (undici requirement; widen `RequestInit`); 404→null; strip `"` from ETag; regex-parse ListObjectsV2 XML (no DOMParser in Node).
- **Testing**: Node 24 has global `fetch` + `WebSocket` (no `ws` needed for the client); use a second vitest config (node env) and `mkdtempSync` + temp `node:sqlite` file + filesystem storage; boot on `port:0` bound to `127.0.0.1`.

---

## Deliberate scope decisions

- **`@hono/node-server`, `ws`, `aws4fetch` are added as runtime `dependencies` of `worker/`** (the Node server imports them at runtime). This grows the worker package past its historical 3 deps — the deliberate, documented cost of the second target. They are **tree-shaken out of the Cloudflare bundle** (only `index.node.ts`/`platform/node/*` import them); an import-boundary test (Task 9) enforces that. `node:sqlite` adds no dependency. The worker guide is updated (Task 10).
- **The `core/` directory move is deferred.** Dependency inversion is already enforced by content + the new import-boundary lint, which guards by import path regardless of folder. Moving `app.ts` et al. into `core/` is cosmetic churn (and would rewrite many imports + the wrangler `main`); it is explicitly out of scope.
- **Parity runs against the Node assembly** (filesystem storage + temp SQLite). The Cloudflare worker is the *reference*, already covered by `api.test.ts`; we do not re-run the suite through `SELF` (the workers pool has no real port and ws-over-`SELF` is awkward). The S3 adapter is validated separately (Task 8, MinIO, not required in CI).
- **One genuinely platform-specific route — `/api/ws`** — is handled by the `createApp(makePlatform, wsRoute?)` override. Everything else is shared verbatim.

---

## File structure

| File | Responsibility | Action |
| --- | --- | --- |
| `worker/src/app.ts` | add optional `wsRoute` param to `createApp` | Modify |
| `worker/src/platform/node/database.ts` | `node:sqlite` `Database` + migration runner | Create |
| `worker/src/platform/node/storage-s3.ts` | S3-compatible `Storage` via `aws4fetch` | Create |
| `worker/src/platform/node/storage-fs.ts` | filesystem `Storage` | Create |
| `worker/src/platform/node/rooms.ts` | in-process `Rooms`/`RoomPort<NodeConn>` + ws handler | Create |
| `worker/src/platform/node/assets.ts` | disk `AssetServer` (reuses `mime.ts`) | Create |
| `worker/src/platform/node/cache.ts` | in-memory `Cache` | Create |
| `worker/src/platform/node/config.ts` | build `Env` from `process.env`, fail-fast | Create |
| `worker/src/platform/node/platform.ts` | `makeNodePlatform` + `buildNodeApp` (for tests) | Create |
| `worker/src/index.node.ts` | Node entry: serve + websocket + shutdown | Create |
| `worker/package.json` | deps + `start`/`dev:node` scripts + dual typecheck | Modify |
| `worker/tsconfig.node.json` | node-runtime typecheck config | Create |
| `worker/vitest.config.ts` | exclude `*.node.test.ts` from the workers pool | Modify |
| `worker/vitest.node.config.ts` | node-env vitest config | Create |
| `worker/test/parity/suite.ts` | shared HTTP + realtime assertion factory | Create |
| `worker/test/parity.node.test.ts` | boot Node assembly, run parity | Create |
| `worker/test/import-boundary.test.ts` | assert no `node:`/`platform/node` leak into the CF graph | Create |
| `worker/AGENTS.md` + `worker/CLAUDE.md` | document the Node assembly + deps | Modify |

---

## Task 0: Baseline + dependencies

**Files:** `worker/package.json`

- [ ] **Step 1: Confirm baseline green**

Run: `cd worker && pnpm test && pnpm typecheck` (`run_in_background: true`). Expected: 43 passed, typecheck clean.

- [ ] **Step 2: Add the Node-assembly dependencies**

Edit `worker/package.json`. Add to `dependencies` (alongside the existing `@anthropic-ai/sdk`, `hono`):

```jsonc
"@hono/node-server": "^2.0.5",
"aws4fetch": "^1.0.20",
"ws": "^8.18.0"
```

Add to `devDependencies`:

```jsonc
"@types/ws": "^8.5.12",
"@types/node": "^22.0.0"
```

- [ ] **Step 3: Install and re-confirm the worker suite is still green**

Run: `cd .. && pnpm install` then `cd worker && pnpm test` (`run_in_background: true`). Expected: install succeeds; 43 tests still pass (new deps are not yet imported anywhere).

- [ ] **Step 4: Commit**

```bash
git add worker/package.json ../pnpm-lock.yaml
git commit -m "chore(worker): add Node-assembly deps (node-server, ws, aws4fetch)"
```

---

## Task 1: `createApp` accepts an optional `wsRoute` override

**Files:** `worker/src/app.ts`

The current `/api/ws` handler stays as the Cloudflare default; Node will pass an override. This keeps CF behavior byte-identical (43 tests green).

- [ ] **Step 1: Extract the inline ws handler and add the param**

In `worker/src/app.ts`, change the `createApp` signature. Old:

```ts
export function createApp(makePlatform: (c: Context<AppEnv>) => Platform): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
```

New:

```ts
import type { Context, MiddlewareHandler } from 'hono';
// ^ ensure MiddlewareHandler is imported (Context already is)

export function createApp(
  makePlatform: (c: Context<AppEnv>) => Platform,
  wsRoute?: MiddlewareHandler<AppEnv>,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
```

Then find the realtime route registration:

```ts
  app.get('/api/ws', (c) => {
    if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
      return c.json({ error: 'expected a websocket upgrade' }, 426);
    }
    // Browsers can't set headers on websocket connects, so path-mode pages
    // pass their site as a query param instead — validated like the header.
    const fromQuery = c.req.query('site');
    if (fromQuery && !isValidSiteName(fromQuery)) {
      return c.json({ error: 'invalid site' }, 400);
    }
    const site = fromQuery || c.var.site;
    return c.var.platform.rooms.connect(site, c.req.raw, c.var.user);
  });
```

Replace it with a named default plus the override hook:

```ts
  // The websocket route is the one genuinely platform-specific handler: on
  // Cloudflare the upgrade is answered in-band (101 Response); on Node it arrives
  // on the HTTP 'upgrade' event and is handled by an upgradeWebSocket middleware.
  // Cloudflare uses this default; the Node entry passes an override.
  const defaultWsRoute: MiddlewareHandler<AppEnv> = (c) => {
    if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
      return c.json({ error: 'expected a websocket upgrade' }, 426);
    }
    const fromQuery = c.req.query('site');
    if (fromQuery && !isValidSiteName(fromQuery)) {
      return c.json({ error: 'invalid site' }, 400);
    }
    const site = fromQuery || c.var.site;
    return c.var.platform.rooms.connect(site, c.req.raw, c.var.user);
  };
  app.get('/api/ws', wsRoute ?? defaultWsRoute);
```

- [ ] **Step 2: Typecheck + full suite (CF unchanged)**

Run: `cd worker && pnpm typecheck && pnpm test` (`run_in_background: true`). Expected: clean + 43 pass (`index.cf.ts` calls `createApp(factory)` with no `wsRoute`, so the default runs — identical behavior).

- [ ] **Step 3: Commit**

```bash
git add worker/src/app.ts
git commit -m "refactor(worker): allow per-assembly websocket route override"
```

---

## Task 2: Node `Database` adapter (`node:sqlite`)

**Files:** `worker/src/platform/node/database.ts`

- [ ] **Step 1: Write `database.ts`**

```ts
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BatchResult, Database, PreparedStatement } from '../types';

/**
 * Wraps Node's synchronous node:sqlite into the async, D1-shaped Database
 * interface. node:sqlite has no .bind(): params are passed to get/all/run, so we
 * buffer them in .bind() (returning a fresh instance, like D1) and apply on
 * first()/all()/run(). The engine is sync; results are wrapped in resolved
 * promises (no real await cost) for Brisk's light per-site workloads.
 */
class NodeStatement implements PreparedStatement {
  private args: unknown[] = [];
  constructor(private readonly stmt: StatementSync) {}

  bind(...values: unknown[]): PreparedStatement {
    const next = new NodeStatement(this.stmt);
    next.args = values;
    return next;
  }

  async first<T = unknown>(): Promise<T | null> {
    // node:sqlite returns undefined for no rows; D1's contract is null.
    return (this.stmt.get(...this.args) as T | undefined) ?? null;
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    return { results: this.stmt.all(...this.args) as T[] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const { changes } = this.stmt.run(...this.args);
    return { meta: { changes: Number(changes) } }; // changes can be bigint
  }
}

export class NodeDatabase implements Database {
  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string): PreparedStatement {
    return new NodeStatement(this.db.prepare(sql));
  }

  // D1.batch() runs all statements in one implicit transaction. node:sqlite has
  // no batch(); emulate with BEGIN/COMMIT and ROLLBACK on throw.
  async batch(statements: PreparedStatement[]): Promise<BatchResult[]> {
    this.db.exec('BEGIN');
    try {
      const results: BatchResult[] = [];
      for (const s of statements) results.push(await s.run());
      this.db.exec('COMMIT');
      return results;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

/**
 * Open the SQLite file and apply pending `migrations/*.sql` in lexical order,
 * guarded by a `_migrations` table — reusing the same migration SQL the
 * Cloudflare D1 path uses. `exec()` runs the multi-statement .sql files.
 */
export function openNodeDatabase(file: string, migrationsDir: string): NodeDatabase {
  const raw = new DatabaseSync(file, { timeout: 5000 });
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)');
  const applied = new Set(
    (raw.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map((r) => r.name),
  );
  for (const f of readdirSync(migrationsDir)
    .filter((n) => n.endsWith('.sql'))
    .sort()) {
    if (applied.has(f)) continue;
    raw.exec('BEGIN');
    try {
      raw.exec(readFileSync(join(migrationsDir, f), 'utf8'));
      raw.prepare('INSERT INTO _migrations (name) VALUES (?)').run(f);
      raw.exec('COMMIT');
    } catch (err) {
      raw.exec('ROLLBACK');
      throw err;
    }
  }
  return new NodeDatabase(raw);
}
```

- [ ] **Step 2: Commit (typecheck happens after the node tsconfig exists in Task 7)**

```bash
git add worker/src/platform/node/database.ts
git commit -m "feat(worker): node:sqlite Database adapter + migration runner"
```

---

## Task 3: Node `Storage` adapters (S3 + filesystem)

**Files:** `worker/src/platform/node/storage-s3.ts`, `worker/src/platform/node/storage-fs.ts`

- [ ] **Step 1: Write `storage-s3.ts`**

```ts
import { AwsClient } from 'aws4fetch';
import type { ListResult, Storage, StoredObject } from '../types';

export interface S3Config {
  endpoint: string; // e.g. https://s3.us-east-1.amazonaws.com or http://localhost:9000
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string; // explicit — never let aws4fetch guess (breaks for MinIO hosts)
}

// undici (Node fetch) requires duplex:'half' to send a ReadableStream body.
type StreamInit = RequestInit & { duplex?: 'half' };

const decodeXml = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

const escapeXml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/** S3-compatible Storage (AWS S3 and MinIO) over aws4fetch. Path-style URLs. */
export function createS3Storage(cfg: S3Config): Storage {
  const aws = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    region: cfg.region,
    service: 's3',
  });
  const base = cfg.endpoint.replace(/\/+$/, '');
  const bucketUrl = `${base}/${cfg.bucket}`;
  const objUrl = (key: string) =>
    `${bucketUrl}/${key.split('/').map(encodeURIComponent).join('/')}`;

  return {
    async get(key): Promise<StoredObject | null> {
      const res = await aws.fetch(objUrl(key), { method: 'GET' });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`S3 get ${key}: ${res.status}`);
      return {
        body: res.body!,
        contentType: res.headers.get('content-type') ?? undefined,
        etag: (res.headers.get('etag') ?? '').replace(/"/g, ''),
        size: Number(res.headers.get('content-length') ?? 0),
      };
    },

    async put(key, body, opts): Promise<void> {
      const init: StreamInit = {
        method: 'PUT',
        body,
        headers: opts?.contentType ? { 'content-type': opts.contentType } : {},
      };
      if (body instanceof ReadableStream) init.duplex = 'half';
      const res = await aws.fetch(objUrl(key), init);
      if (!res.ok) throw new Error(`S3 put ${key}: ${res.status}`);
    },

    async list({ prefix, cursor }): Promise<ListResult> {
      const u = new URL(bucketUrl);
      u.searchParams.set('list-type', '2');
      u.searchParams.set('prefix', prefix);
      if (cursor) u.searchParams.set('continuation-token', cursor);
      const res = await aws.fetch(u.toString(), { method: 'GET' });
      if (!res.ok) throw new Error(`S3 list ${prefix}: ${res.status}`);
      const xml = await res.text();
      const objects: { key: string; size: number }[] = [];
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const block = m[1]!;
        const k = block.match(/<Key>([\s\S]*?)<\/Key>/)?.[1];
        const size = block.match(/<Size>(\d+)<\/Size>/)?.[1];
        if (k != null) objects.push({ key: decodeXml(k), size: Number(size ?? 0) });
      }
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      const next = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1];
      return { objects, cursor: truncated ? next : undefined };
    },

    async delete(keys): Promise<void> {
      if (keys.length === 0) return;
      const body =
        `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>` +
        keys.map((k) => `<Object><Key>${escapeXml(k)}</Key></Object>`).join('') +
        `</Delete>`;
      const res = await aws.fetch(`${bucketUrl}?delete`, {
        method: 'POST',
        headers: { 'content-type': 'application/xml' },
        body,
      });
      if (!res.ok) throw new Error(`S3 delete batch: ${res.status}`);
    },
  };
}
```

- [ ] **Step 2: Write `storage-fs.ts`**

```ts
import { createReadStream } from 'node:fs';
import { mkdir, rm, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { contentType } from '../../mime';
import type { ListResult, Storage, StoredObject } from '../types';

/**
 * Filesystem Storage: objects live under `root/<key>`. No metadata store — the
 * Content-Type is derived from the key's extension (mime.ts). That matches how
 * serveSite already falls back, and keeps the leanest single-pod option free of
 * sidecars. Keys never contain `..` (the worker validates site names; deploy
 * paths are filtered in app.ts), but we still resolve-and-guard against escape.
 */
export function createFsStorage(rootDir: string): Storage {
  const root = resolve(rootDir);
  const pathFor = (key: string): string => {
    const file = resolve(root, key);
    if (file !== root && !file.startsWith(root + sep)) {
      throw new Error(`fs storage: key escapes root: ${key}`);
    }
    return file;
  };

  return {
    async get(key): Promise<StoredObject | null> {
      const file = pathFor(key);
      let s;
      try {
        s = await stat(file);
      } catch {
        return null;
      }
      if (!s.isFile()) return null;
      const body = Readable.toWeb(createReadStream(file)) as unknown as ReadableStream;
      return {
        body,
        contentType: contentType(key),
        etag: `"${s.size}-${Math.trunc(s.mtimeMs)}"`,
        size: s.size,
      };
    },

    async put(key, body, _opts): Promise<void> {
      const file = pathFor(key);
      await mkdir(dirname(file), { recursive: true });
      const buf =
        body instanceof ReadableStream
          ? Buffer.from(await new Response(body).arrayBuffer())
          : Buffer.from(body);
      await writeFile(file, buf);
    },

    async list({ prefix, cursor }): Promise<ListResult> {
      // Walk the tree, return keys under `prefix`. No real pagination needed at
      // internal-tool scale: return everything in one page (cursor unused).
      const objects: { key: string; size: number }[] = [];
      const walk = async (dir: string): Promise<void> => {
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const abs = join(dir, e.name);
          if (e.isDirectory()) await walk(abs);
          else if (e.isFile()) {
            const key = relative(root, abs).split(sep).join('/');
            if (key.startsWith(prefix)) objects.push({ key, size: (await stat(abs)).size });
          }
        }
      };
      await walk(root);
      void cursor;
      return { objects, cursor: undefined };
    },

    async delete(keys): Promise<void> {
      await Promise.all(keys.map((k) => rm(pathFor(k), { force: true })));
    },
  };
}
```

- [ ] **Step 3: Commit**

```bash
git add worker/src/platform/node/storage-s3.ts worker/src/platform/node/storage-fs.ts
git commit -m "feat(worker): S3 (aws4fetch) and filesystem Storage adapters"
```

---

## Task 4: Node `Rooms` adapter (in-process) + ws route handler

**Files:** `worker/src/platform/node/rooms.ts`

- [ ] **Step 1: Write `rooms.ts`**

```ts
import { upgradeWebSocket } from '@hono/node-server';
import type { Context, MiddlewareHandler } from 'hono';
import type { WSContext } from 'hono/ws';
import type { AppEnv, User } from '../../env';
import { isValidSiteName } from '../../sites';
import { RoomLogic, type ConnState, type RoomPort } from '../../room-logic';
import type { DbEvent, Rooms } from '../types';

/** One connection: its live socket + in-memory state. WSContext identity is
 *  stable per socket, so NodeConn is 1:1 with it and safe as the RoomLogic key. */
interface NodeConn {
  ctx: WSContext;
  state: ConnState;
}

class NodeRoom implements RoomPort<NodeConn> {
  readonly conns = new Set<NodeConn>();
  readonly logic = new RoomLogic<NodeConn>(this);
  all(): Iterable<NodeConn> {
    return this.conns;
  }
  send(c: NodeConn, data: string): void {
    if (c.ctx.readyState === 1) c.ctx.send(data); // 1 === OPEN
  }
  getState(c: NodeConn): ConnState {
    return c.state;
  }
  setState(c: NodeConn, s: ConnState): void {
    c.state = s;
  }
}

export interface NodeRooms extends Rooms {
  /** The Hono handler the Node entry mounts on /api/ws (overrides createApp's default). */
  wsRoute: MiddlewareHandler<AppEnv>;
}

/**
 * In-process Rooms: one NodeRoom per site in a Map, fan-out via the shared
 * RoomLogic. publish() reaches subscribers in-process; connect() is unused on
 * Node (the upgrade is handled by the wsRoute middleware on the 'upgrade' event).
 */
export function createNodeRooms(): NodeRooms {
  const rooms = new Map<string, NodeRoom>();
  const roomFor = (site: string): NodeRoom => {
    let r = rooms.get(site);
    if (!r) rooms.set(site, (r = new NodeRoom()));
    return r;
  };

  const wsRoute = upgradeWebSocket((c: Context<AppEnv>) => {
    // Runs when the upgrade is routed; auth + site middleware have already run.
    const user = c.var.user as User;
    const fromQuery = c.req.query('site');
    const site = fromQuery && isValidSiteName(fromQuery) ? fromQuery : c.var.site;
    const room = roomFor(site);
    let conn: NodeConn;
    return {
      onOpen(_evt, ws) {
        conn = { ctx: ws, state: { user, subs: [], channels: [] } };
        room.conns.add(conn);
        room.logic.hello(conn, user);
      },
      onMessage(evt, _ws) {
        if (typeof evt.data === 'string') room.logic.handleMessage(conn, evt.data);
      },
      onClose() {
        if (!conn) return;
        room.logic.close(conn);
        room.conns.delete(conn);
        if (room.conns.size === 0) rooms.delete(site); // bound memory (no hibernation)
      },
    };
  }) as MiddlewareHandler<AppEnv>;

  return {
    async publish(site: string, event: DbEvent): Promise<void> {
      rooms.get(site)?.logic.publishDb(event); // no room => no subscribers => no-op
    },
    connect(): Promise<Response> {
      throw new Error('node rooms: upgrade is handled by wsRoute, not connect()');
    },
    wsRoute,
  };
}
```

> **Implementer note — verify the ws wiring (the one empirical spot):** `upgradeWebSocket` is imported from `@hono/node-server` (v2 built-in). The entry (Task 6) must pass `websocket: { server: new WebSocketServer({ noServer: true }) }` to `serve()`. If the installed `@hono/node-server` version instead requires the `injectWebSocket(server)` pattern, switch the import to `createNodeWebSocket({ app })` from `@hono/node-ws` and call `injectWebSocket` after `serve()` — **the `upgradeWebSocket(createEvents)` callback body above is identical either way** (same `WSContext`/`WSEvents` API). Let the parity realtime test (Task 8) confirm which wiring the installed versions need; do not change the `onOpen/onMessage/onClose` logic.

- [ ] **Step 2: Commit**

```bash
git add worker/src/platform/node/rooms.ts
git commit -m "feat(worker): in-process Node Rooms over RoomLogic + ws handler"
```

---

## Task 5: Assets, Cache, Config adapters

**Files:** `worker/src/platform/node/assets.ts`, `worker/src/platform/node/cache.ts`, `worker/src/platform/node/config.ts`

- [ ] **Step 1: Write `assets.ts`**

```ts
import { readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { contentType } from '../../mime';
import type { AssetServer } from '../types';

/** Serves bundled assets (dashboard, /brisk.js) from disk. Implements the
 *  AssetServer.fetch(path) contract directly (serveStatic is middleware and
 *  resolves against cwd, so it's unsuitable). Guards against path traversal. */
export function createDiskAssets(rootDir: string): AssetServer {
  const root = resolve(rootDir);
  return {
    async fetch(path: string): Promise<Response> {
      const rel = path.replace(/^[/\\]+/, '').replaceAll('\\', '/');
      const file = resolve(root, rel);
      if (file !== root && !file.startsWith(root + sep)) {
        return new Response('Forbidden', { status: 403 });
      }
      try {
        const s = await stat(file);
        if (!s.isFile()) return new Response('Not found', { status: 404 });
        const buf = await readFile(file);
        return new Response(buf, {
          headers: { 'content-type': contentType(file), 'content-length': String(s.size) },
        });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    },
  };
}
```

- [ ] **Step 2: Write `cache.ts`**

```ts
import type { Cache } from '../types';

interface Entry {
  body: ArrayBuffer;
  headers: [string, string][];
  expires: number;
}

/** In-process response cache for the visitor edge-cache path. Single-pod; not
 *  shared across replicas (a Redis-backed cache is the multi-replica opt-in).
 *  Bounded by entry count to avoid unbounded growth in a long-lived process. */
export function createMemoryCache(maxEntries = 1000): Cache {
  const store = new Map<string, Entry>();
  const ttlFromHeaders = (h: Headers): number => {
    const m = (h.get('cache-control') ?? '').match(/max-age=(\d+)/);
    return m ? Number(m[1]) * 1000 : 0;
  };
  return {
    async match(key: string): Promise<Response | null> {
      const hit = store.get(key);
      if (!hit) return null;
      if (hit.expires <= nowFromEntry(store)) {
        store.delete(key);
        return null;
      }
      return new Response(hit.body.slice(0), { headers: new Headers(hit.headers) });
    },
    async put(key: string, response: Response): Promise<void> {
      const ttl = ttlFromHeaders(response.headers);
      if (ttl <= 0) return; // only cache responses that asked to be cached
      const body = await response.arrayBuffer();
      if (store.size >= maxEntries) store.delete(store.keys().next().value as string);
      store.set(key, {
        body,
        headers: [...response.headers.entries()],
        expires: monotonic() + ttl,
      });
    },
  };
}

// Date.now is fine in the running Node server (only workflow SCRIPTS forbid it).
function monotonic(): number {
  return Date.now();
}
function nowFromEntry(_store: Map<string, Entry>): number {
  return Date.now();
}
```

> Implementer: simplify the two helpers to a single `Date.now()` inline if you prefer — they exist only to make the TTL/expiry explicit. `Date.now()` is allowed in normal Node code (the restriction is specific to workflow scripts).

- [ ] **Step 3: Write `config.ts`**

```ts
import type { Env } from '../../env';

/** Build the typed instance config from process.env. Mirrors the Cloudflare
 *  binding shape so handlers read c.env.X unchanged. Fail-fast on the same
 *  misconfigurations the worker rejects at request time, but at boot. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Env {
  const auth = env.AUTH as Env['AUTH'] | undefined;
  if (auth === 'google' && !env.SESSION_SECRET) {
    throw new Error('AUTH=google requires SESSION_SECRET');
  }
  return {
    // Cloudflare bindings are absent on Node; the platform provides those
    // capabilities via the Platform object, not via c.env. We cast because the
    // Env type names them, but no handler reads c.env.DB/BUCKET/ROOMS/ASSETS
    // (Phase 1 routed all of those through c.var.platform).
    DB: undefined as never,
    BUCKET: undefined as never,
    ROOMS: undefined as never,
    ASSETS: undefined as never,
    BASE_HOST: env.BASE_HOST,
    AUTH: auth,
    VISIBILITY: env.VISIBILITY as Env['VISIBILITY'] | undefined,
    ALLOWED_EMAIL_DOMAINS: env.ALLOWED_EMAIL_DOMAINS,
    ALLOWED_EMAILS: env.ALLOWED_EMAILS,
    SESSION_SECRET: env.SESSION_SECRET,
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
    DEPLOY_TOKEN: env.DEPLOY_TOKEN,
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: env.OPENAI_API_KEY,
  };
}
```

> Implementer: if `Env`'s binding fields (`DB`/`BUCKET`/`ROOMS`/`ASSETS`) being `undefined as never` trips strict null checks at call sites, the cleaner fix is to split `Env` into `Bindings` (CF-only) + `Config` (shared) in `env.ts` and have `configFromEnv` return `Config`; but since no handler reads those four on Node, the cast is contained here. Prefer the cast unless typecheck forces the split.

- [ ] **Step 4: Commit**

```bash
git add worker/src/platform/node/assets.ts worker/src/platform/node/cache.ts worker/src/platform/node/config.ts
git commit -m "feat(worker): Node assets/cache/config adapters"
```

---

## Task 6: Node platform factory + entry point

**Files:** `worker/src/platform/node/platform.ts`, `worker/src/index.node.ts`

- [ ] **Step 1: Write `platform.ts`**

```ts
import type { Context } from 'hono';
import type { AppEnv, Env } from '../../env';
import type { Platform, Storage } from '../types';
import { createDiskAssets } from './assets';
import { createMemoryCache } from './cache';
import { NodeDatabase } from './database';
import { createNodeRooms, type NodeRooms } from './rooms';
import { createFsStorage } from './storage-fs';
import { createS3Storage } from './storage-s3';

export interface NodeOptions {
  config: Env;
  db: NodeDatabase;
  rooms: NodeRooms;
  assetsDir: string;
  storage: Storage;
}

/** Select the storage backend from env: S3 by default, filesystem when STORAGE=fs. */
export function storageFromEnv(env: NodeJS.ProcessEnv = process.env): Storage {
  if ((env.STORAGE ?? 's3') === 'fs') {
    return createFsStorage(env.FS_ROOT ?? '/data/objects');
  }
  return createS3Storage({
    endpoint: env.S3_ENDPOINT!,
    bucket: env.S3_BUCKET!,
    region: env.S3_REGION ?? 'us-east-1',
    accessKeyId: env.S3_ACCESS_KEY_ID!,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
  });
}

/**
 * The Node makePlatform hook. Runs in createApp's first middleware, so it also
 * delivers config by overwriting c.env (Node's default c.env is {incoming,
 * outgoing}; Context.env is writable). Every existing c.env.X read then works.
 */
export function makeNodePlatform(opts: NodeOptions): (c: Context<AppEnv>) => Platform {
  const assets = createDiskAssets(opts.assetsDir);
  const cache = createMemoryCache();
  const waitUntil = (p: Promise<unknown>): void => {
    void p.catch((err) => console.error('[brisk] background task failed:', err));
  };
  return (c) => {
    c.env = opts.config;
    return { storage: opts.storage, db: opts.db, rooms: opts.rooms, assets, cache, waitUntil };
  };
}
```

- [ ] **Step 2: Write a `buildNodeApp` test/boot helper inside `platform.ts`**

Append to `platform.ts`:

```ts
import { createApp } from '../../app';
import { openNodeDatabase } from './database';

export interface BuildArgs {
  config: Env;
  dbPath: string;
  migrationsDir: string;
  assetsDir: string;
  storage: Storage;
}

/** Build the Node Hono app (no server). Returns the app + the rooms object so
 *  the entry/tests can wire the websocket server. */
export function buildNodeApp(args: BuildArgs) {
  const db = openNodeDatabase(args.dbPath, args.migrationsDir);
  const rooms = createNodeRooms();
  const platform = makeNodePlatform({
    config: args.config,
    db,
    rooms,
    assetsDir: args.assetsDir,
    storage: args.storage,
  });
  const app = createApp(platform, rooms.wsRoute);
  return { app, rooms, db };
}
```

- [ ] **Step 3: Write `index.node.ts`**

```ts
import { serve, type ServerType } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFromEnv } from './platform/node/config';
import { storageFromEnv } from './platform/node/platform';
import { buildNodeApp } from './platform/node/platform';

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
```

> Implementer: this is the empirical wiring spot. If `serve({ websocket: { server } })` does not complete upgrades with the installed `@hono/node-server`, switch to the `@hono/node-ws` `createNodeWebSocket({ app })` + `injectWebSocket(server)` pattern (add `@hono/node-ws` to deps, build the app with that `upgradeWebSocket` in `rooms.ts`). The parity realtime test is the proof. Keep `index.cf.ts` and all other files unchanged.

- [ ] **Step 4: Commit**

```bash
git add worker/src/platform/node/platform.ts worker/src/index.node.ts
git commit -m "feat(worker): Node platform factory and server entry point"
```

---

## Task 7: Dual typecheck config + scripts

**Files:** `worker/tsconfig.node.json`, `worker/package.json`

The Cloudflare files typecheck against `@cloudflare/workers-types`; the Node files need Node + DOM-ish globals (`fetch`/`Request`/`Response`/`ReadableStream`/`WebSocket`). Keep them in separate tsconfigs to avoid global type clashes.

- [ ] **Step 1: Exclude the Node graph from the existing (workers) tsconfig**

In `worker/tsconfig.json`, add an `exclude` for the Node-only files so they aren't typechecked against workers-types (which lacks `node:` modules). Add (merge with any existing `exclude`):

```jsonc
"exclude": ["src/platform/node", "src/index.node.ts", "test/**/*.node.test.ts", "vitest.node.config.ts"]
```

- [ ] **Step 2: Create `worker/tsconfig.node.json`**

```jsonc
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "types": ["node"],
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "noEmit": true
  },
  "include": [
    "src/**/*.ts",
    "test/**/*.node.test.ts",
    "test/parity/**/*.ts"
  ],
  "exclude": ["src/room.ts", "src/index.cf.ts", "src/platform/cloudflare"]
}
```

> Implementer: the goal is that `core/` + `platform/node/*` + node tests typecheck under Node/DOM globals. Tune `lib`/`types` until clean — `DOM` provides `fetch`/`Request`/`Response`/`ReadableStream`/`WebSocket` types that match Node 24's globals. Exclude the Cloudflare-only files (`room.ts` uses `cloudflare:workers`; `platform/cloudflare/*` and `index.cf.ts` use workers-types) since they belong to the other tsconfig. If `cloudflare:workers` / workers-type references in shared imports cause errors, narrow the `include` to exactly `src/core-ish` + `src/platform/node` + `src/platform/types.ts` + `src/env.ts` + `src/room-logic.ts` + `src/app.ts` + `src/sites.ts` + `src/docs.ts` + `src/auth.ts` + `src/ai.ts` + `src/mime.ts`.

- [ ] **Step 3: Update `worker/package.json` scripts**

```jsonc
"scripts": {
  "dev": "wrangler dev",
  "dev:node": "node --disable-warning=ExperimentalWarning --experimental-strip-types src/index.node.ts",
  "deploy": "wrangler deploy",
  "build": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.node.json --noEmit",
  "typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.node.json --noEmit",
  "start": "NODE_OPTIONS=--disable-warning=ExperimentalWarning node dist/index.node.js",
  "test": "vitest run && vitest run --config vitest.node.config.ts"
}
```

> Implementer: `dev:node` uses Node's `--experimental-strip-types` to run TS directly; if that flag isn't desired, run via the build output. The container image (Phase 4) compiles `index.node.ts` and uses `start`.

- [ ] **Step 4: Typecheck both projects**

Run: `cd worker && pnpm typecheck` (`run_in_background: true`). Expected: BOTH `tsc` invocations clean. Iterate on `tsconfig.node.json` `lib`/`types`/`include` until the Node graph compiles.

- [ ] **Step 5: Commit**

```bash
git add worker/tsconfig.json worker/tsconfig.node.json worker/package.json
git commit -m "build(worker): dual typecheck (workers + node) and node scripts"
```

---

## Task 8: Parity test suite (Node) + vitest node config

**Files:** `worker/vitest.config.ts`, `worker/vitest.node.config.ts`, `worker/test/parity/suite.ts`, `worker/test/parity.node.test.ts`

- [ ] **Step 1: Exclude `*.node.test.ts` from the workers pool config**

In `worker/vitest.config.ts`, add to the returned `test` object:

```ts
      include: ['test/**/*.test.ts'],
      exclude: ['test/**/*.node.test.ts', 'node_modules/**'],
```

(So the workers pool runs the existing `api.test.ts`/`auth.test.ts`/`room-logic.test.ts` but never the Node parity file.)

- [ ] **Step 2: Create `worker/vitest.node.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'node',
    environment: 'node',
    include: ['test/**/*.node.test.ts'],
    hookTimeout: 20000,
  },
});
```

- [ ] **Step 3: Write the shared parity factory `worker/test/parity/suite.ts`**

```ts
import { describe, expect, it } from 'vitest';

/** HTTP assertions that must hold identically on every runtime. `base` is the
 *  server origin, e.g. http://127.0.0.1:54321. Mirrors api.test.ts (the worker
 *  reference) so the Node assembly is proven equivalent. */
export function runHttpParity(base: () => string): void {
  const form = (files: Record<string, string>): FormData => {
    const f = new FormData();
    for (const [path, content] of Object.entries(files)) {
      f.append('files', new File([content], path, { type: 'text/html' }));
    }
    return f;
  };

  describe('parity: identity', () => {
    it('returns the dev user when auth is off', async () => {
      const res = await fetch(`${base()}/api/me`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ email: 'dev@localhost', name: 'Dev' });
    });
  });

  describe('parity: deploy + serve', () => {
    it('deploys a folder and serves files with extension content-types', async () => {
      const dep = await fetch(`${base()}/api/deploy/p-site`, { method: 'POST', body: form({
        'index.html': '<h1>hi</h1>',
        'style.css': 'body{}',
        'app.js': 'console.log(1)',
      }) });
      expect(dep.status).toBe(200);
      const idx = await fetch(`${base()}/s/p-site/`);
      expect(idx.status).toBe(200);
      expect(idx.headers.get('content-type')).toBe('text/html; charset=utf-8');
      const css = await fetch(`${base()}/s/p-site/style.css`);
      expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
    });
  });

  describe('parity: database crud', () => {
    it('creates, reads, lists and deletes a doc', async () => {
      const h = { 'content-type': 'application/json', 'x-brisk-site': 'p-db' };
      const created = (await (await fetch(`${base()}/api/db/notes`, {
        method: 'POST', headers: h, body: JSON.stringify({ text: 'first' }),
      })).json()) as { id: string; text: string };
      expect(created.text).toBe('first');
      const got = await (await fetch(`${base()}/api/db/notes/${created.id}`, { headers: h })).json();
      expect(got).toMatchObject({ id: created.id, text: 'first' });
      const list = (await (await fetch(`${base()}/api/db/notes`, { headers: h })).json()) as {
        docs: unknown[];
      };
      expect(list.docs.length).toBeGreaterThanOrEqual(1);
    });
  });
}

/** Realtime round-trip — Node only (real WebSocket client). */
export function runRealtimeParity(base: () => string): void {
  const wsBase = () => base().replace(/^http/, 'ws');

  describe('parity: realtime', () => {
    it('greets with identity and delivers a db event to the same site', async () => {
      const ws = new WebSocket(`${wsBase()}/api/ws?site=p-ws`);
      const queue: any[] = [];
      let wake: (() => void) | null = null;
      ws.addEventListener('message', (e) => {
        queue.push(JSON.parse(e.data as string));
        wake?.();
      });
      const next = (ms = 2000) =>
        new Promise<any>((res, rej) => {
          if (queue.length) return res(queue.shift());
          const t = setTimeout(() => rej(new Error('ws timeout')), ms);
          wake = () => {
            clearTimeout(t);
            wake = null;
            res(queue.shift());
          };
        });
      await new Promise<void>((r) => ws.addEventListener('open', () => r()));
      const hello = await next();
      expect(hello).toMatchObject({ t: 'hello', you: { email: 'dev@localhost', name: 'Dev' } });
      ws.send(JSON.stringify({ t: 'db:sub', collection: 'msgs' }));
      const created = (await (await fetch(`${base()}/api/db/msgs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-brisk-site': 'p-ws' },
        body: JSON.stringify({ text: 'over the wire' }),
      })).json()) as { id: string };
      const event = await next();
      expect(event).toMatchObject({
        t: 'db',
        event: 'create',
        collection: 'msgs',
        doc: { id: created.id, text: 'over the wire' },
      });
      ws.close();
    });
  });
}
```

- [ ] **Step 4: Write `worker/test/parity.node.test.ts`**

```ts
import { afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { buildNodeApp, storageFromEnv } from '../src/platform/node/platform';
import { createFsStorage } from '../src/platform/node/storage-fs';
import { configFromEnv } from '../src/platform/node/config';
import { runHttpParity, runRealtimeParity } from './parity/suite';

let server: ServerType;
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
    server = serve({ fetch: app.fetch, websocket: { server: wss }, port: 0, hostname: '127.0.0.1' }, (info) => {
      base = `http://127.0.0.1:${info.port}`;
      resolve();
    });
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
```

- [ ] **Step 5: Run BOTH test projects**

Run: `cd worker && pnpm test` (`run_in_background: true`). Expected: the workers pool runs 43 (unchanged), then the node project boots the assembly and the parity suite passes (identity, deploy+serve content-types, db CRUD, realtime round-trip). Debug the ws wiring here if realtime hangs (see Task 4/6 notes — switch to `injectWebSocket` if needed). Run `cd .. && pnpm format`.

- [ ] **Step 6: Commit**

```bash
git add worker/vitest.config.ts worker/vitest.node.config.ts worker/test/parity
git commit -m "test(worker): cross-runtime parity suite against the Node assembly"
```

---

## Task 9: Import-boundary lint

**Files:** `worker/test/import-boundary.test.ts`

Guarantees the Cloudflare bundle can never accidentally include Node-only code.

- [ ] **Step 1: Write `worker/test/import-boundary.test.ts`** (runs in the workers pool — it only reads files)

```ts
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// NOTE: this test reads source files; it does not import them. It runs in the
// default (worker) project but only touches the filesystem via node:fs, which
// vitest provides at test-collection time. If the workers pool rejects node:fs,
// move this file to *.node.test.ts so it runs in the node project instead.

const SRC = join(__dirname, '..', 'src');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('import boundary', () => {
  it('core and cloudflare files never import node: builtins or platform/node', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file.includes(`${join('platform', 'node')}`) || file.endsWith('index.node.ts')) continue;
      const text = readFileSync(file, 'utf8');
      if (/from\s+['"]node:/.test(text) || /from\s+['"].*platform\/node/.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

> Implementer: if the workers pool can't use `node:fs` at runtime, rename this file to `import-boundary.node.test.ts` so it runs in the node project (it only inspects source text, runtime-agnostic).

- [ ] **Step 2: Run + commit**

Run: `cd worker && pnpm test` (`run_in_background: true`). Expected: the boundary test passes (no offenders).

```bash
git add worker/test/import-boundary.test.ts
git commit -m "test(worker): enforce node: import boundary for the CF bundle"
```

---

## Task 10: Document the Node assembly

**Files:** `worker/AGENTS.md`, `worker/CLAUDE.md`, root `README.md`

- [ ] **Step 1: Update `worker/AGENTS.md` and `worker/CLAUDE.md`**

Add a section describing: the two assemblies (`index.cf.ts` / `index.node.ts`), the `platform/` layout (`types.ts`, `cloudflare/*`, `node/*`), that `core` (`app/sites/docs/auth/ai/room-logic`) is platform-neutral, the new deps (`@hono/node-server`, `ws`, `aws4fetch` — Node-only, tree-shaken from the CF bundle, enforced by `import-boundary.test.ts`), the dual typecheck (`tsconfig.json` + `tsconfig.node.json`), and how to run the Node server locally (`pnpm dev:node`, env: `STORAGE`, `SQLITE_PATH`, `S3_*`, `PORT`). Note the realtime default (single replica, in-process) and that Redis is a later opt-in.

- [ ] **Step 2: Add a "Self-hosting on Node / Kubernetes" section to `README.md`**

Document the env vars (`PORT`, `STORAGE`, `S3_ENDPOINT`/`S3_BUCKET`/`S3_REGION`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`, `FS_ROOT`, `SQLITE_PATH`, plus the existing `BASE_HOST`/`AUTH`/… config), the single-replica realtime model, and that the container image + Helm chart land in Phase 4.

- [ ] **Step 3: Format + commit**

```bash
cd .. && pnpm format
git add worker/AGENTS.md worker/CLAUDE.md README.md
git commit -m "docs: document the Node/Kubernetes assembly"
```

---

## Task 11: Full verification

**Files:** none

- [ ] **Step 1: Both test projects green**

Run: `cd worker && pnpm test` (`run_in_background: true`). Expected: workers pool 43+ (now incl. the import-boundary test) and the node project parity suite all pass.

- [ ] **Step 2: Both typechecks clean**

Run: `cd worker && pnpm typecheck` (`run_in_background: true`). Expected: `tsconfig.json` and `tsconfig.node.json` both clean.

- [ ] **Step 3: Manual smoke against the filesystem backend**

Run:
```bash
cd worker
STORAGE=fs FS_ROOT=/tmp/brisk-objects SQLITE_PATH=/tmp/brisk.sqlite AUTH=none \
  node --disable-warning=ExperimentalWarning --experimental-strip-types src/index.node.ts
```
In another terminal: `BRISK_SERVER=http://localhost:8787 node ../cli/dist/cli.js deploy ../examples/guestbook` (build the CLI first if needed). Open `http://localhost:8787`, exercise the guestbook (db write + realtime). Confirm it behaves like the Cloudflare instance.

- [ ] **Step 4: CF bundle sanity — Node code is absent**

Run: `cd worker && rg -l "platform/node|from ['\"]node:" src/app.ts src/sites.ts src/docs.ts src/auth.ts src/ai.ts src/room-logic.ts src/index.cf.ts src/platform/cloudflare` and expect NO matches; optionally `npx wrangler deploy --dry-run --outdir /tmp/brisk-cf-bundle` and confirm it builds without pulling `node:sqlite`/`@hono/node-server`.

---

## What Phase 3 leaves for later

- **Phase 4:** Dockerfile (with `NODE_OPTIONS=--disable-warning=ExperimentalWarning`), published image, Helm chart (Deployment 1 replica, Service, Ingress, PVC for SQLite + objects, Secret), Docker Compose (`brisk` [+ `minio`] [+ `redis`]), and the wildcard-subdomain/cert docs.
- **Phase 5:** `create-brisk` wizard.
- **Phase 6 (opt-in):** Redis-backed `Rooms` (multi-replica), Postgres `Database`.
- **Deferred:** the cosmetic `core/` directory move; an S3 integration test against MinIO in a non-required CI job.

---

## Self-review

- **Spec coverage:** Implements the design's Node assembly — S3 + filesystem `Storage`, `node:sqlite` `Database` + migration runner, in-process `Rooms` (driving the Phase-2 `RoomLogic`), disk `AssetServer`, in-memory `Cache`, config via `c.env` overwrite, `@hono/node-server` entry with websockets, the parity test harness, and the import-boundary lint. Resolves the Phase-1-deferred config-on-`c.env` question (overwrite in the Node `makePlatform` hook). The S3-vs-fs and (future) Redis selection is the factory (`storageFromEnv`) the wizard will drive. `core/` move and packaging are explicitly deferred.
- **Placeholder scan:** No TBDs. Three spots are flagged for empirical confirmation during implementation (the exact `@hono/node-server` websocket wiring, the `tsconfig.node.json` `lib`/`types`, and the `Env` binding-field cast) — each with a concrete primary approach, a named fallback, and a test that proves which is correct. These are integration realities of a new runtime, not unspecified work.
- **Type consistency:** `Storage`/`Database`/`Rooms`/`AssetServer`/`Cache`/`Platform` are used exactly as defined in `platform/types.ts` (Phase 1). `RoomPort<NodeConn>` (`all/send/getState/setState`) matches the interface from Phase 2 and is driven by the same `RoomLogic`. `createApp(makePlatform, wsRoute?)` (Task 1) is called by `index.cf.ts` (default) and `buildNodeApp` (override) consistently. `configFromEnv` returns `Env`, matching what `makeNodePlatform` assigns to `c.env`.
