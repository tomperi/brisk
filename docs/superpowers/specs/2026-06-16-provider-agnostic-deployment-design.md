# Provider-agnostic Brisk: self-hosting on Kubernetes

**Date:** 2026-06-16
**Status:** Design — approved for planning

## Goal

Let a company deploy the open-source Brisk into **their own infrastructure**
(EKS and other Kubernetes, or plain Docker) **without Cloudflare**, while
keeping Brisk lean and simple. Cloudflare remains a first-class, unchanged
target — this adds a second way to run the same product, it does not replace
the first.

Non-goals: changing the product (still six primitives, no new knobs in the
*product* surface), abandoning the Cloudflare path, or building a general
plugin framework. The trust model is unchanged.

## The constraint that shapes everything

A Cloudflare Worker bundle (workerd) **cannot** import Node built-ins
(`node:sqlite`, `@hono/node-server`); a Node process has no Durable Objects,
R2, D1, `caches.default`, or `executionCtx.waitUntil`. The two runtimes expose
different APIs. Therefore:

- "Cloudflare vs Kubernetes" is selected at **build time** — by which entry
  point you build/run — not by a runtime flag on one binary.
- There is **one shared `core/`** (the application logic) and **two build
  outputs**: a workerd bundle (`wrangler deploy`) and a Node container image
  (`docker`). "Same app logic, two thin build targets."
- A **single Node image** serves every Kubernetes/Docker adapter combination,
  selecting adapters at runtime from environment variables.

## Architecture

### Three interfaces, two assemblies

`core/` route handlers stop calling Cloudflare bindings directly. Instead they
depend on three interfaces whose shape matches exactly what the code uses
today (verified by audit):

- **`Storage`** — `get / put / list / delete` + `httpMetadata` / `etag`
  (mirrors current R2 usage 1:1; no presigned URLs, no multipart)
- **`Database`** — `prepare().bind().first/all/run` + `batch()`
  (mirrors current D1 usage 1:1; standard SQL only)
- **`Rooms`** — get a room for a site, publish an event, accept a websocket

The AI proxy is already provider-pluggable (Anthropic/OpenAI by key) and the
`@anthropic-ai/sdk` is isomorphic, so AI needs no interface — it stays in
`core/`.

Two **assemblies** (entry points) wire concrete implementations into the
**same Hono app**:

| Assembly | Storage | Database | Rooms | Runtime |
| --- | --- | --- | --- | --- |
| `index.cf.ts` (Cloudflare) | `R2Storage` | `D1Database` | `DurableObjectRooms` | workerd, per-request bindings |
| `index.node.ts` (Node/K8s) | `S3Storage` | `SqliteDatabase` | `InProcessRooms` (+ optional Redis) | `@hono/node-server` + `@hono/node-ws`, singletons at boot |

### The `Platform` object on the Hono context

Everything that diverges between runtimes is bundled into a single object
injected onto the Hono context, the same way `c.var.site` already is:

```ts
type Platform = {
  storage: Storage
  db: Database
  rooms: Rooms
  assets: AssetServer          // CF: env.ASSETS fetcher; Node: serve from disk
  cache: Cache                 // CF: caches.default; Node: in-memory / no-op
  waitUntil: (p: Promise<unknown>) => void   // CF: ctx.waitUntil; Node: run + log
  config: Config               // normalized env (BASE_HOST, AUTH, …)
}
```

`createApp()` is shared. Each assembly provides a tiny middleware that
populates `c.var.platform`. This also resolves a Cloudflare lifecycle wrinkle:
on Cloudflare, bindings exist only inside `fetch(req, env, ctx)`, so the CF
middleware builds `Platform` **per request** from `(env, ctx)`; on Node, the
middleware hands over **app-level singletons** built once at boot from
`process.env`. Same context shape; handlers never know which platform they run
on.

### Why shared logic actually compiles to both runtimes

Dependency inversion enforced by **tree-shaking per entry point**:

```
index.cf.ts   ─→ core/* ─→ platform/types.ts          (interfaces only; erased at compile time)
              └→ platform/cloudflare/*  (R2 / D1 / DO; imports @cloudflare/workers-types)

index.node.ts ─→ core/* ─→ platform/types.ts
              └→ platform/node/*  (S3 / SQLite / ws; imports node:sqlite, aws4fetch)
```

`core/` imports only `platform/types.ts` (pure TypeScript types, zero runtime)
plus Web-standard APIs present on **both** runtimes. Concrete adapters — the
only code touching `node:*` or CF bindings — are imported **exclusively** by
entry points. The bundler follows only what an entry point imports, so
`node:sqlite` never enters the worker bundle and DO globals never enter the
Node build.

Audit of what `core/` touches at runtime confirms the only divergent
capabilities are exactly the ones already behind `Platform`:

| Capability | Both runtimes? | Resolution |
| --- | --- | --- |
| `fetch` / `Request` / `Response` / `URL` / `ReadableStream` | yes (Web standard) | use directly |
| `crypto.subtle` (JWT in auth) | yes (workerd + Node) | use directly |
| Hono, `@anthropic-ai/sdk` | yes (isomorphic) | use directly |
| Object storage | no (R2 vs S3) | `platform.storage` |
| SQL | no (D1 async vs SQLite sync) | `platform.db` |
| Realtime | no (DO vs node-ws) | `platform.rooms` |
| Edge cache (`caches.default`) | no (CF only) | `platform.cache` |
| `waitUntil` | no (CF only) | `platform.waitUntil` |
| Static assets (`env.ASSETS`) | no (CF only) | `platform.assets` |

Shape mismatches are absorbed **inside** adapters, never in core: the
`Database` interface is Promise-returning, so the SQLite adapter wraps its
synchronous `node:sqlite` calls; the `Storage` interface speaks
`ReadableStream`, so each adapter normalizes to `{ body, httpMetadata, etag }`.

A CI lint enforces the boundary: files under `core/` and
`platform/cloudflare/` may never import `node:*` or from `platform/node/`. An
accidental violation breaks the `wrangler` build loudly — a good guardrail.

### Directory layout

```
worker/src/
  core/            app.ts, sites.ts, docs.ts, auth.ts, ai.ts   ← shared, platform-agnostic
  platform/
    types.ts       Storage | Database | Rooms | Platform | Config
    cloudflare/    r2 · d1 · do-rooms · assets · cache · config
    node/          s3 · sqlite · inproc-rooms · redis-rooms · assets · cache · config · factory
  index.cf.ts      wires cloudflare/*  (per-request middleware)
  index.node.ts    factory wires node/* from env (singletons at boot)
```

## Realtime: the one real refactor

Today `room.ts` mixes **DO plumbing** (`WebSocketPair`, `acceptWebSocket`,
`serializeAttachment` / `deserializeAttachment`, the DO `fetch` /
`webSocketMessage` / `webSocketClose` lifecycle) with **fan-out logic** (who is
subscribed, presence tracking, routing a db-event / channel message to the
right sockets). The two runtimes' websocket models are structurally different,
so config cannot bridge them.

**Plan:** extract the fan-out into a platform-neutral `RoomLogic` that operates
on an abstract set of connections (each carrying its in-memory attachment
`{ user, subs, channels }`). Two thin shells drive it:

- **Cloudflare:** the `SiteRoom` Durable Object feeds connect/message/close
  events into `RoomLogic`. Hibernation/attachment serialization stays in this
  shell only.
- **Node:** an `@hono/node-ws` handler feeds the same events into the same
  `RoomLogic`, holding connections in a `Map<site, Set<Conn>>` in memory. No
  hibernation, no serialization — a long-lived process keeps state in memory,
  which makes this shell *simpler* than the DO.

### Default topology: single replica

The Node realtime default is **one pod, in-process rooms** — zero external
services. Fan-out is a local map. A pod restart drops live sockets, but the SDK
already auto-reconnects, so it is a blip. Scale is vertical. For an internal
tool this matches (and in raw capacity exceeds) Cloudflare's free-tier request
ceiling.

### Opt-in: multi-replica via Redis

For teams that must run multiple replicas, a `RedisRooms` implementation wraps
`InProcessRooms` and uses Redis pub/sub for cross-pod fan-out, with presence in
Redis. It sits behind the same `Rooms` interface, selected by `REDIS_URL` being
set. **Off by default** — it is the only place self-hosting needs extra infra,
and we keep it opt-in so the default stays lean.

## Self-host backends (defaults)

- **Storage: S3-compatible**, implemented with `aws4fetch` (tiny, zero
  transitive deps, by Cloudflare) doing SigV4 over `fetch` — keeps the S3
  adapter as plain fetch calls. One adapter covers AWS S3, MinIO, GCS (S3
  mode), and R2. Config: `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`,
  `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (IRSA on EKS supported via the
  standard credential chain where applicable).
- **Database: SQLite on a PVC**, implemented with Node's **built-in
  `node:sqlite`** (zero dependency; Node 24, which CI already targets). The
  adapter maps the async `Database` interface onto synchronous calls and maps
  `.batch()` onto a transaction. The existing D1 migration SQL is reused by a
  tiny migration runner. Config: `SQLITE_PATH` (a file on the mounted volume).

This yields the lean default stack: **one pod + one PVC for the SQLite file +
one S3 bucket for blobs + in-process websockets + pass-through AI keys.** No
external services required.

`Database` adapter shipped opt-in: **Postgres** (for teams that want managed
RDS / multi-replica). `Storage` adapter shipped opt-in: **filesystem/PVC** (for
the absolute-minimum, no-object-store case). Both sit behind their interfaces
so they are contained additions, selected by env.

## Distribution: the install wizard

A separate **`create-brisk`** package (`npm create brisk@latest`) — kept out of
the zero-dep site-author `brisk` CLI so that stays tiny. It scaffolds the
**deployment glue and config against the shared image**, never a forked source
tree:

```
? Target               › Cloudflare Workers │ Kubernetes │ Docker Compose
? Storage  (if not CF)  › S3-compatible (endpoint/bucket) │ Filesystem (PVC)
? Database (if not CF)  › SQLite on PVC │ Postgres
? Realtime (if K8s)     › Single replica │ Multi-replica + Redis
? Auth                  › None (trusted network) │ Google OAuth
? Base host             › brisk.example.com

→ Cloudflare      → configured wrangler.jsonc + secrets checklist
→ Kubernetes      → Helm values.yaml + Deployment/Service/Ingress/PVC/Secret + README
→ Docker Compose  → docker-compose.yml (brisk [+ minio] [+ redis]) + .env
```

We deliberately reject scaffolding a bespoke source tree per user: that creates
snapshots that drift from upstream, so security fixes (Brisk ships them — see
recent hardening commits) would require every install to regenerate and
re-merge. Shared image + generated config means `docker pull` delivers the fix
and the wizard only ever writes YAML and `.env`. Because one image must serve
every Kubernetes answer, the Node assembly ships the **factory with the opt-ins
wired** (S3/FS, SQLite/Postgres, in-process/Redis); the wizard picks which env
vars get set.

A prebuilt image is published (e.g. `ghcr.io/usebrisk/brisk`) so operators do
not build from source.

## Configuration surface (Node assembly)

Existing product vars are unchanged (`BASE_HOST`, `AUTH`, `VISIBILITY`,
`ALLOWED_EMAILS`, `ALLOWED_EMAIL_DOMAINS`, `SESSION_SECRET`, `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `DEPLOY_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`).
New infrastructure vars (Node only):

| Var | Purpose | Default |
| --- | --- | --- |
| `PORT` | HTTP listen port | `8787` |
| `STORAGE` | `s3` \| `fs` | `s3` |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_REGION` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | S3 target | — |
| `FS_ROOT` | filesystem storage root (if `STORAGE=fs`) | — |
| `DATABASE` | `sqlite` \| `postgres` | `sqlite` |
| `SQLITE_PATH` | SQLite file on the PVC | `/data/brisk.sqlite` |
| `DATABASE_URL` | Postgres DSN (if `DATABASE=postgres`) | — |
| `REDIS_URL` | enables multi-replica rooms when set | unset (in-process) |

## Testing

- **Cloudflare** keeps the current integration suite
  (`@cloudflare/vitest-pool-workers`, `SELF.fetch`).
- **Node** gets its own integration run: boot the Node server (against MinIO +
  a temp SQLite file) and exercise it over HTTP.
- **Parity:** the same black-box HTTP suite runs against both assemblies via a
  base URL, proving the shared `core/` behaves identically on both runtimes.
- Pure helpers (`siteFromHost`, `isValidSiteName`) stay directly unit-tested.

## Implementation phases

Each phase is independently shippable and leaves the product working.

1. **Interface extraction (pure refactor).** Introduce `platform/types.ts`,
   move existing CF code into `platform/cloudflare/*`, route handlers through
   `c.var.platform`, split `index.cf.ts`. No behavior change; the existing
   Cloudflare test suite must still pass. Add the `core/` import-boundary lint.
2. **Realtime neutralization.** Extract `RoomLogic` from `room.ts`; the DO
   becomes a thin shell over it. Still Cloudflare-only; tests unchanged.
3. **Node assembly.** Add `platform/node/*` (S3, SQLite, in-process rooms,
   assets, cache, config, factory), `index.node.ts`, the Node server + node-ws
   shell, the migration runner, and the Node/parity test runs.
4. **Packaging.** Dockerfile, published image, Helm chart/manifests, Docker
   Compose, and docs.
5. **Wizard.** The `create-brisk` package generating per-target deployment
   glue.
6. **(Opt-in, as needed)** Redis rooms, Postgres database, filesystem storage
   adapters behind their interfaces.

## Open risks

- **Streaming uploads on Node `fetch`** need `duplex: 'half'`; an S3-adapter
  detail, not core.
- **`RoomLogic` extraction** is the only non-mechanical refactor; it must
  preserve the realtime wire protocol
  ([docs/realtime-protocol.md](../../realtime-protocol.md)) exactly so the SDK
  is unchanged.
- **Two build targets = two CI lanes**; the parity suite is what keeps them
  honest.
