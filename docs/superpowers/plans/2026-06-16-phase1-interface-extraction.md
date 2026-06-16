# Phase 1: Platform Interface Extraction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the worker so route handlers depend on platform-neutral interfaces (`Storage`, `Database`, `Rooms`, `AssetServer`, `Cache`, plus `waitUntil`) injected via a `Platform` object on the Hono context, with Cloudflare adapters wired by the entry point — without changing any runtime behavior.

**Architecture:** Introduce `src/platform/types.ts` (the interfaces) and `src/platform/cloudflare/*` (R2/D1/DO/assets/cache adapters + a `buildCloudflarePlatform` factory). A `Platform` object is injected onto `c.var.platform` by a middleware registered first; the factory is passed into `createApp()`. Handlers in `app.ts`/`sites.ts`/`docs.ts` stop touching `c.env.BUCKET/DB/ROOMS/ASSETS`, `caches.default`, and `c.executionCtx` directly. This is a pure refactor; the existing `@cloudflare/vitest-pool-workers` suite is the regression gate.

**Tech Stack:** TypeScript (strict, bundler resolution, extensionless imports), Hono, Cloudflare Workers (R2/D1/Durable Objects), vitest + `@cloudflare/vitest-pool-workers`.

---

## Scope notes & deliberate deviations from the design doc

- **Config stays on `c.env`** in Phase 1. The design doc lists `config` as a `Platform` field, but config is plain env strings (not a runtime-divergent capability) and both runtimes can expose it via `c.env`. Keeping it there leaves `auth.ts` and `ai.ts` **untouched** in Phase 1, shrinking the blast radius. Phase 3 owns wiring config into `c.env` on the Node assembly (or moving it to `Platform.config` then). `siteUrl` and `siteFromHost` keep their current signatures because tests call them directly (`test/api.test.ts:43`).
- **No `core/` directory move** in Phase 1. Files stay at `src/` root; we only *add* `src/platform/`. The dependency inversion is achieved by what handlers import, not by folder names. The `core/` vs `platform/` split and the import-boundary lint land in Phase 3, when a `platform/node/` folder exists for the lint to actually guard.
- **`room.ts` stays put** (still the CF Durable Object). Its `RoomLogic` extraction is Phase 2. Phase 1 only routes DO access through the `Rooms` adapter and moves the `DbEvent` type to `platform/types.ts`.

---

## File structure

| File | Responsibility | Action |
| --- | --- | --- |
| `worker/src/platform/types.ts` | All platform interfaces + `DbEvent` | Create |
| `worker/src/platform/cloudflare/storage.ts` | `Storage` over `R2Bucket` | Create |
| `worker/src/platform/cloudflare/rooms.ts` | `Rooms` over `DurableObjectNamespace` | Create |
| `worker/src/platform/cloudflare/assets.ts` | `AssetServer` over the `ASSETS` Fetcher | Create |
| `worker/src/platform/cloudflare/cache.ts` | `Cache` over `caches.default` | Create |
| `worker/src/platform/cloudflare/platform.ts` | `buildCloudflarePlatform(env, ctx)` | Create |
| `worker/src/env.ts` | Add `platform` to `AppEnv['Variables']` | Modify |
| `worker/src/docs.ts` | `DocStore` ctor takes `Database` | Modify |
| `worker/src/sites.ts` | Functions take `Platform`; normalized storage object | Modify |
| `worker/src/app.ts` | Platform middleware; handlers use `c.var.platform`; `createApp(makePlatform)` | Modify |
| `worker/src/room.ts` | Import `DbEvent` from `platform/types` | Modify |
| `worker/src/index.ts` → `worker/src/index.cf.ts` | CF entry: `createApp(buildCloudflarePlatform)` + `export { SiteRoom }` | Rename + modify |
| `worker/wrangler.jsonc` | `main` → `src/index.cf.ts` | Modify |

---

## Task 0: Baseline — confirm the suite is green before touching anything

**Files:** none

- [ ] **Step 1: Run the full worker suite and typecheck to capture the baseline**

Run: `cd worker && pnpm test && pnpm typecheck`
Expected: all tests PASS, typecheck clean. If anything is red here, stop — Phase 1 assumes a green baseline.

---

## Task 1: Define the platform interfaces

**Files:**
- Create: `worker/src/platform/types.ts`

- [ ] **Step 1: Write `platform/types.ts`**

```ts
import type { User } from '../env';

/**
 * Platform-neutral seams. `core` (app/sites/docs) depends only on these
 * interfaces plus Web-standard APIs; concrete adapters live under
 * `platform/<runtime>/` and are wired in by the entry point. Every shape here
 * mirrors exactly what the current Cloudflare code already uses.
 */

// ---- storage (R2 ↔ S3 ↔ filesystem) --------------------------------------

export interface StoredObject {
  body: ReadableStream;
  /** Stored Content-Type, if any was recorded on write. */
  contentType?: string;
  etag: string;
  size: number;
}

export interface ListedObject {
  key: string;
  size: number;
}

export interface ListResult {
  objects: ListedObject[];
  /** Set only when the listing was truncated — drives the pagination loop. */
  cursor?: string;
}

export interface Storage {
  get(key: string): Promise<StoredObject | null>;
  put(
    key: string,
    body: ReadableStream | ArrayBuffer,
    opts?: { contentType?: string },
  ): Promise<void>;
  list(opts: { prefix: string; cursor?: string }): Promise<ListResult>;
  delete(keys: string[]): Promise<void>;
}

// ---- database (D1 ↔ SQLite ↔ Postgres) -----------------------------------
// Shape matches D1 so the Cloudflare adapter is the binding itself.

export interface PreparedStatement {
  bind(...values: unknown[]): PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

export interface BatchResult {
  meta: { changes: number };
}

export interface Database {
  prepare(sql: string): PreparedStatement;
  batch(statements: PreparedStatement[]): Promise<BatchResult[]>;
}

// ---- realtime (Durable Object ↔ in-process ↔ Redis) ----------------------

export interface DbEvent {
  collection: string;
  event: 'create' | 'update' | 'delete';
  doc?: Record<string, unknown>;
  id?: string;
}

export interface Rooms {
  /** Fan out a db change event to subscribers of `site`. */
  publish(site: string, event: DbEvent): Promise<void>;
  /** Handle a websocket upgrade for `site`; returns the 101 response. */
  connect(site: string, request: Request, user: User): Promise<Response>;
}

// ---- static assets (the dashboard / brisk.js) ----------------------------

export interface AssetServer {
  /** Fetch a bundled asset by path (e.g. `/docs.html`, `/brisk.js`). */
  fetch(path: string): Promise<Response>;
}

// ---- edge/response cache (visitor mode) ----------------------------------

export interface Cache {
  match(key: string): Promise<Response | null>;
  put(key: string, response: Response): Promise<void>;
}

// ---- the bundle handed to every request ----------------------------------

export interface Platform {
  storage: Storage;
  db: Database;
  rooms: Rooms;
  assets: AssetServer;
  cache: Cache;
  /** Run background work without blocking the response. */
  waitUntil: (p: Promise<unknown>) => void;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd worker && pnpm typecheck`
Expected: clean (pure type file; `User` import resolves from `../env`).

- [ ] **Step 3: Commit**

```bash
git add worker/src/platform/types.ts
git commit -m "feat(worker): add platform interface types"
```

---

## Task 2: Cloudflare adapters + factory

**Files:**
- Create: `worker/src/platform/cloudflare/storage.ts`
- Create: `worker/src/platform/cloudflare/rooms.ts`
- Create: `worker/src/platform/cloudflare/assets.ts`
- Create: `worker/src/platform/cloudflare/cache.ts`
- Create: `worker/src/platform/cloudflare/platform.ts`

- [ ] **Step 1: Write `platform/cloudflare/storage.ts`**

```ts
import type { Storage } from '../types';

/** R2 implementation of `Storage`. Normalizes R2's httpMetadata/httpEtag into
 *  the flat `StoredObject` shape; Brisk only ever stores a Content-Type. */
export function cloudflareStorage(bucket: R2Bucket): Storage {
  return {
    async get(key) {
      const o = await bucket.get(key);
      if (!o) return null;
      const h = new Headers();
      o.writeHttpMetadata(h);
      return {
        body: o.body,
        contentType: h.get('content-type') ?? undefined,
        etag: o.httpEtag,
        size: o.size,
      };
    },
    async put(key, body, opts) {
      await bucket.put(
        key,
        body,
        opts?.contentType ? { httpMetadata: { contentType: opts.contentType } } : undefined,
      );
    },
    async list({ prefix, cursor }) {
      const page = await bucket.list({ prefix, cursor });
      return {
        objects: page.objects.map((o) => ({ key: o.key, size: o.size })),
        cursor: page.truncated ? page.cursor : undefined,
      };
    },
    async delete(keys) {
      await bucket.delete(keys);
    },
  };
}
```

- [ ] **Step 2: Write `platform/cloudflare/rooms.ts`**

```ts
import type { DbEvent, Rooms } from '../types';
import type { User } from '../../env';

/** Durable Object implementation of `Rooms`: one DO instance per site,
 *  addressed by name. Encodes the user into the upgrade request the DO reads. */
export function cloudflareRooms(ns: DurableObjectNamespace): Rooms {
  const stub = (site: string) => ns.get(ns.idFromName(site));
  return {
    async publish(site: string, event: DbEvent) {
      await stub(site).fetch('https://room/publish', {
        method: 'POST',
        body: JSON.stringify(event),
      });
    },
    connect(site: string, request: Request, user: User) {
      const headers = new Headers(request.headers);
      headers.set('x-brisk-user', JSON.stringify(user));
      return stub(site).fetch(new Request(request.url, { headers }));
    },
  };
}
```

- [ ] **Step 3: Write `platform/cloudflare/assets.ts`**

```ts
import type { AssetServer } from '../types';

/** Serves bundled assets via the Workers `ASSETS` fetcher binding. The base
 *  origin is arbitrary — only the path matters to the binding. */
export function cloudflareAssets(assets: Fetcher): AssetServer {
  return {
    fetch: (path: string) => assets.fetch(new URL(path, 'https://assets.local')),
  };
}
```

- [ ] **Step 4: Write `platform/cloudflare/cache.ts`**

```ts
import type { Cache } from '../types';

/** Wraps the Cloudflare global edge cache. Keys are URL strings; the original
 *  code already keyed on a query-stripped URL with a `__site` discriminator. */
export function cloudflareCache(): Cache {
  const cache = caches.default;
  return {
    async match(key: string) {
      return (await cache.match(new Request(key))) ?? null;
    },
    async put(key: string, response: Response) {
      await cache.put(new Request(key), response);
    },
  };
}
```

- [ ] **Step 5: Write `platform/cloudflare/platform.ts`**

```ts
import type { Env } from '../../env';
import type { Database, Platform } from '../types';
import { cloudflareAssets } from './assets';
import { cloudflareCache } from './cache';
import { cloudflareRooms } from './rooms';
import { cloudflareStorage } from './storage';

/** Build the per-request Platform from Cloudflare bindings + execution context.
 *  `D1Database` already satisfies the `Database` interface structurally, so it
 *  is used directly. */
export function buildCloudflarePlatform(env: Env, ctx: ExecutionContext): Platform {
  return {
    storage: cloudflareStorage(env.BUCKET),
    db: env.DB as Database,
    rooms: cloudflareRooms(env.ROOMS),
    assets: cloudflareAssets(env.ASSETS),
    cache: cloudflareCache(),
    waitUntil: (p) => ctx.waitUntil(p),
  };
}
```

- [ ] **Step 6: Typecheck**

Run: `cd worker && pnpm typecheck`
Expected: clean. If `env.DB as Database` errors, the `Database` interface in Task 1 diverged from D1's shape — reconcile the interface, do not loosen the cast.

- [ ] **Step 7: Commit**

```bash
git add worker/src/platform/cloudflare
git commit -m "feat(worker): add Cloudflare platform adapters"
```

---

## Task 3: Thread `platform` through the Hono context type

**Files:**
- Modify: `worker/src/env.ts`

- [ ] **Step 1: Import `Platform` and add it to `AppEnv['Variables']`**

In `worker/src/env.ts`, change the `AppEnv` type. Old:

```ts
/** Hono app environment: bindings plus per-request site + user. */
export type AppEnv = {
  Bindings: Env;
  Variables: {
    /** Site this request belongs to (subdomain, /s/<site> prefix, or header). */
    site: string;
    user: User;
  };
};
```

New (add the import at the top of the file, after the existing content, and extend `Variables`):

```ts
import type { Platform } from './platform/types';

/** Hono app environment: bindings plus per-request site + user + platform. */
export type AppEnv = {
  Bindings: Env;
  Variables: {
    /** Site this request belongs to (subdomain, /s/<site> prefix, or header). */
    site: string;
    user: User;
    /** Storage/db/rooms/assets/cache/waitUntil, wired by the entry point. */
    platform: Platform;
  };
};
```

Put the `import type { Platform }` line at the very top of `env.ts` (imports must precede the `export interface Env` declaration).

- [ ] **Step 2: Typecheck**

Run: `cd worker && pnpm typecheck`
Expected: errors ONLY in `app.ts`/`sites.ts`/`docs.ts` where handlers still use `c.env.DB` etc. — those are fixed in the next tasks. `env.ts` itself must be clean. (If you want a clean intermediate typecheck, defer running it until Task 6.)

- [ ] **Step 3: Commit**

```bash
git add worker/src/env.ts
git commit -m "feat(worker): add platform to Hono context variables"
```

---

## Task 4: `DocStore` depends on `Database`

**Files:**
- Modify: `worker/src/docs.ts`

- [ ] **Step 1: Change the constructor type and the field type**

In `worker/src/docs.ts`, add the import and change the constructor. Old:

```ts
export class DocStore {
  constructor(private readonly db: D1Database) {}
```

New:

```ts
import type { Database } from './platform/types';
```
(at the top of the file, before the first `export interface`)

```ts
export class DocStore {
  constructor(private readonly db: Database) {}
```

No other change: every `this.db.prepare(...).bind(...).all/first/run()` call already matches the `Database`/`PreparedStatement` interface.

- [ ] **Step 2: Typecheck this file in isolation by building**

Run: `cd worker && pnpm typecheck`
Expected: no NEW errors originating in `docs.ts` (pre-existing errors in `app.ts` callers are fixed in Task 6).

- [ ] **Step 3: Commit**

```bash
git add worker/src/docs.ts
git commit -m "refactor(worker): DocStore depends on Database interface"
```

---

## Task 5: `sites.ts` takes `Platform`

**Files:**
- Modify: `worker/src/sites.ts`

This rewrites every exported function to receive `Platform` instead of `Env`, routes storage/db through the interface, normalizes `StoredObject` usage, and drops the `ExecutionContext` param from `deploySite` (it now uses `platform.waitUntil`).

- [ ] **Step 1: Replace the imports and `activeDeploy`/list/get helpers**

Old (top of file):

```ts
import { contentType } from './mime';
import type { Env, User } from './env';
```

New:

```ts
import { contentType } from './mime';
import type { User } from './env';
import type { Platform } from './platform/types';
```

Old:

```ts
async function activeDeploy(env: Env, site: string): Promise<string | null> {
  const cached = pointerCache.get(site);
  if (cached && cached.expires > Date.now()) return cached.deploy;
  const row = await env.DB.prepare('SELECT active_deploy FROM sites WHERE name = ?')
    .bind(site)
    .first<{ active_deploy: string }>();
  const deploy = row?.active_deploy ?? null;
  pointerCache.set(site, { deploy, expires: Date.now() + POINTER_TTL_MS });
  return deploy;
}

export async function listSites(env: Env): Promise<SiteInfo[]> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM sites ORDER BY updated_at DESC',
  ).all<SiteRow>();
  return results.map(toInfo);
}

export async function getSite(env: Env, name: string): Promise<SiteInfo | null> {
  const row = await env.DB.prepare('SELECT * FROM sites WHERE name = ?')
    .bind(name)
    .first<SiteRow>();
  return row ? toInfo(row) : null;
}
```

New:

```ts
async function activeDeploy(platform: Platform, site: string): Promise<string | null> {
  const cached = pointerCache.get(site);
  if (cached && cached.expires > Date.now()) return cached.deploy;
  const row = await platform.db
    .prepare('SELECT active_deploy FROM sites WHERE name = ?')
    .bind(site)
    .first<{ active_deploy: string }>();
  const deploy = row?.active_deploy ?? null;
  pointerCache.set(site, { deploy, expires: Date.now() + POINTER_TTL_MS });
  return deploy;
}

export async function listSites(platform: Platform): Promise<SiteInfo[]> {
  const { results } = await platform.db
    .prepare('SELECT * FROM sites ORDER BY updated_at DESC')
    .all<SiteRow>();
  return results.map(toInfo);
}

export async function getSite(platform: Platform, name: string): Promise<SiteInfo | null> {
  const row = await platform.db
    .prepare('SELECT * FROM sites WHERE name = ?')
    .bind(name)
    .first<SiteRow>();
  return row ? toInfo(row) : null;
}
```

- [ ] **Step 2: Replace `serveSite`**

Old:

```ts
export async function serveSite(env: Env, site: string, path: string): Promise<Response | null> {
  const deploy = await activeDeploy(env, site);
  if (!deploy) return null;

  const clean = path.replace(/^\/+/, '');
  if (clean.split('/').includes('..')) return null;
  const candidates = clean ? [clean, `${clean}/index.html`, `${clean}.html`] : ['index.html'];

  for (const candidate of candidates) {
    const object = await env.BUCKET.get(deployPrefix(site, deploy) + candidate);
    if (!object) continue;
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    if (!headers.has('content-type')) headers.set('content-type', contentType(candidate));
    headers.set('etag', object.httpEtag);
    headers.set('cache-control', 'no-cache');
    return new Response(object.body, { headers });
  }
  return null;
}
```

New:

```ts
export async function serveSite(
  platform: Platform,
  site: string,
  path: string,
): Promise<Response | null> {
  const deploy = await activeDeploy(platform, site);
  if (!deploy) return null;

  const clean = path.replace(/^\/+/, '');
  if (clean.split('/').includes('..')) return null;
  const candidates = clean ? [clean, `${clean}/index.html`, `${clean}.html`] : ['index.html'];

  for (const candidate of candidates) {
    const object = await platform.storage.get(deployPrefix(site, deploy) + candidate);
    if (!object) continue;
    const headers = new Headers();
    headers.set('content-type', object.contentType ?? contentType(candidate));
    headers.set('etag', object.etag);
    headers.set('cache-control', 'no-cache');
    return new Response(object.body, { headers });
  }
  return null;
}
```

- [ ] **Step 3: Replace `deploySite` (drop the `ctx` param, use `platform.waitUntil`)**

Old signature + body section:

```ts
export async function deploySite(
  env: Env,
  ctx: ExecutionContext,
  site: string,
  files: DeployFile[],
  user: User,
): Promise<SiteInfo> {
  const previous = await activeDeploy(env, site);
  const deploy = crypto.randomUUID().slice(0, 8);
  const prefix = deployPrefix(site, deploy);

  let bytes = 0;
  const queue = [...files];
  const workers = Array.from({ length: 8 }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      bytes += next.file.size;
      await env.BUCKET.put(prefix + next.path, next.file.stream(), {
        httpMetadata: { contentType: contentType(next.path) },
      });
    }
  });
  await Promise.all(workers);

  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `INSERT INTO sites (name, active_deploy, files, bytes, created_at, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET
       active_deploy = excluded.active_deploy,
       files = excluded.files,
       bytes = excluded.bytes,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by
     RETURNING *`,
  )
    // Attribute to the human name; auth already falls it back to the email.
    .bind(site, deploy, files.length, bytes, now, now, user.name)
    .first<SiteRow>();
  pointerCache.delete(site);

  // Two simultaneous deploys can orphan the loser's prefix; at internal-tool
  // scale that's rare and cheap, so we don't coordinate beyond last-write-wins.
  if (previous && previous !== deploy) {
    ctx.waitUntil(deletePrefix(env, deployPrefix(site, previous)));
  }
  return toInfo(row!);
}
```

New:

```ts
export async function deploySite(
  platform: Platform,
  site: string,
  files: DeployFile[],
  user: User,
): Promise<SiteInfo> {
  const previous = await activeDeploy(platform, site);
  const deploy = crypto.randomUUID().slice(0, 8);
  const prefix = deployPrefix(site, deploy);

  let bytes = 0;
  const queue = [...files];
  const workers = Array.from({ length: 8 }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      bytes += next.file.size;
      await platform.storage.put(prefix + next.path, next.file.stream(), {
        contentType: contentType(next.path),
      });
    }
  });
  await Promise.all(workers);

  const now = new Date().toISOString();
  const row = await platform.db
    .prepare(
      `INSERT INTO sites (name, active_deploy, files, bytes, created_at, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET
       active_deploy = excluded.active_deploy,
       files = excluded.files,
       bytes = excluded.bytes,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by
     RETURNING *`,
    )
    // Attribute to the human name; auth already falls it back to the email.
    .bind(site, deploy, files.length, bytes, now, now, user.name)
    .first<SiteRow>();
  pointerCache.delete(site);

  // Two simultaneous deploys can orphan the loser's prefix; at internal-tool
  // scale that's rare and cheap, so we don't coordinate beyond last-write-wins.
  if (previous && previous !== deploy) {
    platform.waitUntil(deletePrefix(platform, deployPrefix(site, previous)));
  }
  return toInfo(row!);
}
```

- [ ] **Step 4: Replace `listFiles`, `getFile`, `deleteSite`, `deletePrefix`**

Old:

```ts
export async function listFiles(env: Env, site: string): Promise<{ path: string; size: number }[]> {
  const deploy = await activeDeploy(env, site);
  if (!deploy) return [];
  const prefix = deployPrefix(site, deploy);
  const files: { path: string; size: number }[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix, cursor });
    files.push(...page.objects.map((o) => ({ path: o.key.slice(prefix.length), size: o.size })));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return files;
}

/** Exact file from the live deploy, no index/extension resolution. */
export async function getFile(env: Env, site: string, path: string): Promise<Response | null> {
  const deploy = await activeDeploy(env, site);
  if (!deploy) return null;
  const clean = path.replace(/^\/+/, '');
  if (clean.split('/').includes('..')) return null; // parity with serveSite
  const object = await env.BUCKET.get(deployPrefix(site, deploy) + clean);
  if (!object) return null;
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  return new Response(object.body, { headers });
}

export async function deleteSite(env: Env, site: string): Promise<boolean> {
  const [sites] = await env.DB.batch([
    env.DB.prepare('DELETE FROM sites WHERE name = ?').bind(site),
    env.DB.prepare('DELETE FROM docs WHERE site = ?').bind(site),
  ]);
  pointerCache.delete(site);
  await Promise.all([deletePrefix(env, `deploys/${site}/`), deletePrefix(env, `uploads/${site}/`)]);
  return (sites?.meta.changes ?? 0) > 0;
}

async function deletePrefix(env: Env, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix, cursor });
    if (page.objects.length) await env.BUCKET.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
```

New:

```ts
export async function listFiles(
  platform: Platform,
  site: string,
): Promise<{ path: string; size: number }[]> {
  const deploy = await activeDeploy(platform, site);
  if (!deploy) return [];
  const prefix = deployPrefix(site, deploy);
  const files: { path: string; size: number }[] = [];
  let cursor: string | undefined;
  do {
    const page = await platform.storage.list({ prefix, cursor });
    files.push(...page.objects.map((o) => ({ path: o.key.slice(prefix.length), size: o.size })));
    cursor = page.cursor;
  } while (cursor);
  return files;
}

/** Exact file from the live deploy, no index/extension resolution. */
export async function getFile(
  platform: Platform,
  site: string,
  path: string,
): Promise<Response | null> {
  const deploy = await activeDeploy(platform, site);
  if (!deploy) return null;
  const clean = path.replace(/^\/+/, '');
  if (clean.split('/').includes('..')) return null; // parity with serveSite
  const object = await platform.storage.get(deployPrefix(site, deploy) + clean);
  if (!object) return null;
  const headers = new Headers();
  if (object.contentType) headers.set('content-type', object.contentType);
  headers.set('etag', object.etag);
  return new Response(object.body, { headers });
}

export async function deleteSite(platform: Platform, site: string): Promise<boolean> {
  const [sites] = await platform.db.batch([
    platform.db.prepare('DELETE FROM sites WHERE name = ?').bind(site),
    platform.db.prepare('DELETE FROM docs WHERE site = ?').bind(site),
  ]);
  pointerCache.delete(site);
  await Promise.all([
    deletePrefix(platform, `deploys/${site}/`),
    deletePrefix(platform, `uploads/${site}/`),
  ]);
  return (sites?.meta.changes ?? 0) > 0;
}

async function deletePrefix(platform: Platform, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await platform.storage.list({ prefix, cursor });
    if (page.objects.length) await platform.storage.delete(page.objects.map((o) => o.key));
    cursor = page.cursor;
  } while (cursor);
}
```

- [ ] **Step 5: Typecheck**

Run: `cd worker && pnpm typecheck`
Expected: errors now ONLY in `app.ts` (its calls to these functions still pass `c.env`/`c.executionCtx`). Fixed in Task 6.

- [ ] **Step 6: Commit**

```bash
git add worker/src/sites.ts
git commit -m "refactor(worker): sites.ts uses Platform storage/db"
```

---

## Task 6: `app.ts` — inject `Platform`, migrate every handler

**Files:**
- Modify: `worker/src/app.ts`
- Modify: `worker/src/room.ts`

- [ ] **Step 1: Move `DbEvent` off `room.ts`**

In `worker/src/room.ts`, delete the local `DbEvent` declaration and import it instead. Old (top of file):

```ts
import { DurableObject } from 'cloudflare:workers';
import type { Env, User } from './env';
```
and later:
```ts
export interface DbEvent {
  collection: string;
  event: 'create' | 'update' | 'delete';
  doc?: Record<string, unknown>;
  id?: string;
}
```

New: replace the imports with

```ts
import { DurableObject } from 'cloudflare:workers';
import type { Env, User } from './env';
import type { DbEvent } from './platform/types';
```
and DELETE the `export interface DbEvent { ... }` block entirely (it now lives in `platform/types.ts`). Leave the rest of `room.ts` unchanged.

- [ ] **Step 2: Fix `app.ts` imports**

Old:

```ts
import type { DbEvent } from './room';
import type { AppEnv, Env } from './env';
```

New:

```ts
import type { AppEnv } from './env';
import type { DbEvent, Platform } from './platform/types';
```

(`Env` is no longer used directly in `app.ts`; `siteUrl` keeps its inline `{ env: ... }` structural type — see Step 9. If typecheck reports `Env` unused elsewhere, removing it from the import is correct.)

- [ ] **Step 3: Update `createApp` signature and register the platform middleware first**

Old:

```ts
export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.route('', authRoutes());
```

New:

```ts
export function createApp(makePlatform: (c: Context<AppEnv>) => Platform): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Inject the platform first so every route — including the mounted auth
  // routes — can reach storage/db/rooms/cache via c.var.platform.
  app.use('*', async (c, next) => {
    c.set('platform', makePlatform(c));
    return next();
  });

  app.route('', authRoutes());
```

- [ ] **Step 4: Migrate `visitorCached` to `platform.cache` + `platform.waitUntil`**

Old (the cache section inside `visitorCached`):

```ts
  const key = new Request(url.toString(), { method: 'GET' });
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await build();
  if (!res) return null;
  // Buffer the body so the cached copy doesn't keep the R2 stream open.
  const body = await res.arrayBuffer();
  const headers = new Headers(res.headers);
  headers.set('cache-control', `public, max-age=${maxAge}`);
  c.executionCtx.waitUntil(cache.put(key, new Response(body.slice(0), { headers })));
  return new Response(body, { headers });
```

New:

```ts
  const key = url.toString();
  const cache = c.var.platform.cache;
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await build();
  if (!res) return null;
  // Buffer the body so the cached copy doesn't keep the storage stream open.
  const body = await res.arrayBuffer();
  const headers = new Headers(res.headers);
  headers.set('cache-control', `public, max-age=${maxAge}`);
  c.var.platform.waitUntil(cache.put(key, new Response(body.slice(0), { headers })));
  return new Response(body, { headers });
```

- [ ] **Step 5: Migrate the `publish` helper**

Old:

```ts
  const publish = (
    c: { env: Env; executionCtx: ExecutionContext },
    site: string,
    event: DbEvent,
  ) => {
    const room = c.env.ROOMS.get(c.env.ROOMS.idFromName(site));
    c.executionCtx.waitUntil(
      room.fetch('https://room/publish', { method: 'POST', body: JSON.stringify(event) }),
    );
  };
```

New:

```ts
  const publish = (c: Context<AppEnv>, site: string, event: DbEvent) => {
    c.var.platform.waitUntil(c.var.platform.rooms.publish(site, event));
  };
```

- [ ] **Step 6: Migrate the db routes — `new DocStore(c.env.DB)` → `new DocStore(c.var.platform.db)`**

There are five occurrences in the db section. Replace each `new DocStore(c.env.DB)` with `new DocStore(c.var.platform.db)`. The five call sites:
- `GET /api/db`: `const store = new DocStore(c.var.platform.db);`
- `GET /api/db/:collection`: `const store = new DocStore(c.var.platform.db);`
- `POST /api/db/:collection`: `... new DocStore(c.var.platform.db).create(...)`
- `GET /api/db/:collection/:id`: `... new DocStore(c.var.platform.db).get(...)`
- `PATCH /api/db/:collection/:id`: `... new DocStore(c.var.platform.db).update(...)`
- `DELETE /api/db/:collection/:id`: `... new DocStore(c.var.platform.db).delete(...)`

(Use a single find/replace of `new DocStore(c.env.DB)` → `new DocStore(c.var.platform.db)`.)

- [ ] **Step 7: Migrate the upload routes — `c.env.BUCKET` → `c.var.platform.storage`**

In `POST /api/fs/upload`, old:

```ts
        await c.env.BUCKET.put(`uploads/${c.var.site}/${id}/${name}`, file.stream(), {
          httpMetadata: { contentType: file.type || contentType(name) },
        });
```

New:

```ts
        await c.var.platform.storage.put(`uploads/${c.var.site}/${id}/${name}`, file.stream(), {
          contentType: file.type || contentType(name),
        });
```

In `GET /files/:site/:id/:name`, old:

```ts
    const object = await c.env.BUCKET.get(`uploads/${site}/${id}/${name}`);
    if (!object) return c.notFound();
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('cache-control', 'public, max-age=31536000, immutable');
```

New:

```ts
    const object = await c.var.platform.storage.get(`uploads/${site}/${id}/${name}`);
    if (!object) return c.notFound();
    const headers = new Headers();
    if (object.contentType) headers.set('content-type', object.contentType);
    headers.set('etag', object.etag);
    headers.set('cache-control', 'public, max-age=31536000, immutable');
```

(Leave the `x-content-type-options` / `content-disposition` lines and the `return new Response(object.body, { headers })` unchanged.)

- [ ] **Step 8: Migrate the AI route — `chat(c.env, ...)` is unchanged**

`ai.ts` still reads config from `Env`, and `c.env` still carries it on Cloudflare. Leave the two `chat(c.env, ...)` calls in `POST /api/ai/chat` exactly as they are. No change in this step — it is here only to confirm AI is intentionally untouched in Phase 1.

- [ ] **Step 9: Migrate the sites/deploy routes to `c.var.platform`**

Replace the `c.env` arguments in the sites section:

- `GET /api/sites`: `const sites = await listSites(c.var.platform);`
- `GET /api/sites/:name`: `const site = await getSite(c.var.platform, c.req.param('name'));`
- `GET /api/sites/:name/files`: `c.json({ files: await listFiles(c.var.platform, c.req.param('name')) })`
- `GET /api/sites/:name/raw/*`: `const file = await getFile(c.var.platform, name, decodeURIComponent(path));`
- `DELETE /api/sites/:name`: `const existed = await deleteSite(c.var.platform, c.req.param('name'));`
- `POST /api/deploy/:name`: change

  ```ts
  const info = await deploySite(c.env, c.executionCtx, site, files, c.var.user);
  ```
  to
  ```ts
  const info = await deploySite(c.var.platform, site, files, c.var.user);
  ```

Leave `siteUrl(c, ...)` calls unchanged — `siteUrl` still reads `c.env.BASE_HOST` (its signature is pinned by `test/api.test.ts:43`).

- [ ] **Step 10: Migrate the websocket route to `platform.rooms.connect`**

Old (`GET /api/ws`):

```ts
    const headers = new Headers(c.req.raw.headers);
    headers.set('x-brisk-user', JSON.stringify(c.var.user));
    // Browsers can't set headers on websocket connects, so path-mode pages
    // pass their site as a query param instead — validated like the header.
    const fromQuery = c.req.query('site');
    if (fromQuery && !isValidSiteName(fromQuery)) {
      return c.json({ error: 'invalid site' }, 400);
    }
    const site = fromQuery || c.var.site;
    const room = c.env.ROOMS.get(c.env.ROOMS.idFromName(site));
    return room.fetch(new Request(c.req.raw.url, { headers }));
```

New:

```ts
    // Browsers can't set headers on websocket connects, so path-mode pages
    // pass their site as a query param instead — validated like the header.
    const fromQuery = c.req.query('site');
    if (fromQuery && !isValidSiteName(fromQuery)) {
      return c.json({ error: 'invalid site' }, 400);
    }
    const site = fromQuery || c.var.site;
    return c.var.platform.rooms.connect(site, c.req.raw, c.var.user);
```

(The `upgrade` header check above this block is unchanged. The `x-brisk-user` header is now set inside the Cloudflare rooms adapter.)

- [ ] **Step 11: Migrate static serving — `serveSite` + `c.env.ASSETS`**

In `serveSiteFor`, old:

```ts
  const serveSiteFor = (c: Context<AppEnv>, site: string, path: string): Promise<Response | null> =>
    visitorCached(c, () => serveSite(c.env, site, path), 300, site);
```

New:

```ts
  const serveSiteFor = (c: Context<AppEnv>, site: string, path: string): Promise<Response | null> =>
    visitorCached(c, () => serveSite(c.var.platform, site, path), 300, site);
```

In the catch-all `app.get('*', ...)`, old:

```ts
    if (site === 'home') {
      const asset = await c.env.ASSETS.fetch(new URL(path, 'https://assets.local'));
      if (asset.ok) return securedAsset(asset);
    }
    // The SDK is available on every site, deployed or not.
    if (path === '/brisk.js') {
      const asset = await c.env.ASSETS.fetch(new URL('/brisk.js', 'https://assets.local'));
      if (asset.ok) return securedAsset(asset);
    }
```

New:

```ts
    if (site === 'home') {
      const asset = await c.var.platform.assets.fetch(path);
      if (asset.ok) return securedAsset(asset);
    }
    // The SDK is available on every site, deployed or not.
    if (path === '/brisk.js') {
      const asset = await c.var.platform.assets.fetch('/brisk.js');
      if (asset.ok) return securedAsset(asset);
    }
```

- [ ] **Step 12: Typecheck**

Run: `cd worker && pnpm typecheck`
Expected: clean EXCEPT `worker/src/index.ts` (it calls `createApp()` with no argument now). Fixed in Task 7.

- [ ] **Step 13: Commit**

```bash
git add worker/src/app.ts worker/src/room.ts
git commit -m "refactor(worker): handlers use injected Platform"
```

---

## Task 7: CF entry point + wrangler `main` + green suite (the gate)

**Files:**
- Rename: `worker/src/index.ts` → `worker/src/index.cf.ts`
- Modify: `worker/wrangler.jsonc`

- [ ] **Step 1: Rename the entry file**

Run: `cd worker && git mv src/index.ts src/index.cf.ts`

- [ ] **Step 2: Wire the Cloudflare platform factory into the entry**

Replace the contents of `worker/src/index.cf.ts`. Old:

```ts
import { createApp } from './app';

export { SiteRoom } from './room';

export default createApp();
```

New:

```ts
import { createApp } from './app';
import { buildCloudflarePlatform } from './platform/cloudflare/platform';

export { SiteRoom } from './room';

export default createApp((c) => buildCloudflarePlatform(c.env, c.executionCtx));
```

- [ ] **Step 3: Point wrangler at the new entry**

In `worker/wrangler.jsonc`, change:

```jsonc
  "main": "src/index.ts",
```
to
```jsonc
  "main": "src/index.cf.ts",
```

- [ ] **Step 4: Typecheck**

Run: `cd worker && pnpm typecheck`
Expected: clean across the whole package.

- [ ] **Step 5: Run the full integration suite — the regression gate**

Run: `cd worker && pnpm test`
Expected: ALL tests PASS (same set that passed in Task 0). This is the proof the refactor preserved behavior: deploys, serving, db CRUD + realtime publish, uploads, websocket upgrade, auth, and visitor caching all still work through the adapters.

If anything fails, diff the failing path's handler against the originals in this plan — the most likely culprits are the `StoredObject` content-type normalization (Task 5 Step 2 / Task 6 Step 7) or middleware ordering (Task 6 Step 3 must register the platform middleware before `app.route('', authRoutes())`).

- [ ] **Step 6: Format check**

Run: `cd worker && cd .. && pnpm format`
Expected: files reformatted/clean (CI enforces `format:check`).

- [ ] **Step 7: Commit**

```bash
git add worker/src/index.cf.ts worker/wrangler.jsonc
git commit -m "refactor(worker): split CF entry point, wire platform factory"
```

---

## Task 8: Confirm the seam holds end-to-end (smoke + review)

**Files:** none (verification only)

- [ ] **Step 1: Grep for leftover direct binding use in handlers**

Run: `cd worker && rg -n "c\.env\.(DB|BUCKET|ROOMS|ASSETS)|caches\.default|c\.executionCtx" src/app.ts src/sites.ts src/docs.ts`
Expected: NO matches. Any hit is a handler that still bypasses the `Platform` seam — fix it before declaring Phase 1 done. (`c.env.BASE_HOST` in `siteUrl`/`auth.ts` and `chat(c.env, ...)` are expected and fine — they are config, intentionally left on `c.env`.)

- [ ] **Step 2: Confirm adapters are the only Cloudflare-API surface**

Run: `cd worker && rg -ln "writeHttpMetadata|httpEtag|idFromName|WebSocketPair|acceptWebSocket|caches\.default" src/`
Expected: matches ONLY in `src/platform/cloudflare/*` and `src/room.ts` (the DO). Nothing in `app.ts`/`sites.ts`/`docs.ts`.

- [ ] **Step 3: Local smoke (optional but recommended)**

Run:
```bash
cd worker
npx wrangler d1 migrations apply brisk --local
npx wrangler dev
```
In another terminal: `BRISK_SERVER=http://localhost:8787 node ../cli/dist/cli.js deploy ../examples/guestbook` (build the CLI first with `pnpm build` if needed). Open `http://localhost:8787` and the deployed site; exercise the guestbook (db write + realtime). Confirm it behaves exactly as before.

---

## What Phase 1 deliberately leaves for later

- **Phase 2:** extract `RoomLogic` from `room.ts` so the DO becomes a thin shell; relocate it under `platform/cloudflare/`.
- **Phase 3:** `platform/node/*` (S3, SQLite, in-process rooms, assets-from-disk, in-memory cache), `index.node.ts`, `@hono/node-server` + `@hono/node-ws`, the migration runner, the `core/` directory move, the `node:*` import-boundary lint, config delivery on `c.env` for Node, and the parity test suite.
- **Phase 4:** Dockerfile, published image, Helm chart, Docker Compose, docs.
- **Phase 5:** the `create-brisk` wizard.
- **Phase 6 (opt-in):** Redis rooms, Postgres, filesystem storage.

---

## Self-review

- **Spec coverage:** This plan implements the design's "three interfaces + Platform injection" seam and the "dependency inversion / adapters imported only by entry points" mechanism for the Cloudflare side. Storage/Database/Rooms/AssetServer/Cache/waitUntil are all interfaced. The `RoomLogic` extraction, Node assembly, packaging, wizard, and opt-in adapters are explicitly out of scope (later phases) — noted above.
- **Placeholder scan:** No TBDs; every code-changing step shows the exact old→new code or an exact find/replace.
- **Type consistency:** `Platform` fields (`storage`, `db`, `rooms`, `assets`, `cache`, `waitUntil`) are used identically in the factory (Task 2.5), the context type (Task 3), and the handlers (Tasks 5–6). `Storage.list` returns `{ objects, cursor? }` and all callers loop on `page.cursor` (Task 5.4). `Rooms.connect(site, request, user)` is defined in Task 1, implemented in Task 2.2, and called in Task 6.10 with `(site, c.req.raw, c.var.user)`. `Database`/`PreparedStatement` match D1 so `env.DB as Database` (Task 2.5) holds and `DocStore`'s calls (Task 4) are unchanged.
