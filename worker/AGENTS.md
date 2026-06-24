# worker/ — the platform

One Hono app serving every role: static host, API, auth gate, websocket
router, dashboard. Request flow and storage layout: README → Architecture.

## Map

| File           | Owns                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------- |
| `src/app.ts`   | All HTTP routes, site resolution, the static-serving fallback                                       |
| `src/sites.ts` | Deploys (atomic pointer swap), serving from R2, site CRUD, name rules                               |
| `src/docs.ts`  | The document store on D1 (`docs` table)                                                             |
| `src/room.ts`  | `SiteRoom` Durable Object: db events, channels, presence ([protocol](../docs/realtime-protocol.md)) |
| `src/auth.ts`  | Google OAuth, session cookies, dev identity, personal CLI tokens (`/auth/cli`) + CI deploy token    |
| `src/ai.ts`    | Anthropic/OpenAI proxy; provider picked by configured key                                           |
| `assets/`      | The dashboard (the built-in `home` site) + generated `brisk.js`                                     |
| `migrations/`  | D1 schema; add new numbered files, never edit applied ones                                          |

## Two assemblies, one core

The worker has two entry points that wrap the **same** Hono app:

- `src/index.cf.ts` — the Cloudflare build (Worker + R2 + D1 + Durable Objects).
- `src/index.node.ts` — a Node server (`@hono/node-server` + websockets) for
  self-hosting on a VM/Kubernetes. See README → Self-hosting on Node.

Everything under `src/` except the entries and `platform/` is **platform-neutral
core** (`app.ts`, `sites.ts`, `docs.ts`, `auth.ts`, `ai.ts`, `room-logic.ts`,
`mime.ts`). Core depends only on `platform/types.ts` (the six seams: `Storage`,
`Database`, `Rooms`, `AssetServer`, `Cache`, `waitUntil`) plus Web-standard
APIs — never on a runtime. Concrete adapters live under `platform/`:

- `platform/cloudflare/*` — R2/D1/DO/ASSETS/cache bindings (the default).
- `platform/node/*` — `node:sqlite` `Database` + migration runner; S3
  (`aws4fetch`) **and** filesystem `Storage`; in-process `Rooms` driving
  `RoomLogic`; disk `AssetServer`; in-memory `Cache`; `config.ts` (builds the
  `Env` from `process.env`); `platform.ts` (`buildNodeApp`).

`createApp(makePlatform, wsRoute?)` is the seam between them: the websocket
route is the one genuinely platform-specific handler (CF answers the upgrade
in-band; Node handles it via `upgradeWebSocket` on the HTTP `'upgrade'` event),
so Cloudflare uses the default and the Node entry passes an override. The Node
`makePlatform` hook also delivers config by **merging** it onto `c.env`
(`Object.assign`, not replacement — node-server stores upgrade internals on
`c.env` and a replacement breaks websocket upgrades).

### Dependencies and the import boundary

The Node build adds three runtime deps to `worker/` — `@hono/node-server`,
`ws`, `aws4fetch` (`node:sqlite` adds none). They are **Node-only**: only
`index.node.ts`/`platform/node/*` import them, so they tree-shake out of the
Cloudflare bundle. `test/import-boundary.node.test.ts` enforces that core and
`platform/cloudflare` never import `node:` builtins or `platform/node`.

### Dual typecheck and tests

Two tsconfigs: `tsconfig.json` typechecks the workers graph against
`@cloudflare/workers-types` (and excludes `platform/node`); `tsconfig.node.json`
typechecks core + `platform/node` under Node/DOM globals (`lib: DOM`,
`types: node + @cloudflare/workers-types` — the latter still supplies the
`Response.json<T>()` / `Env` binding types the shared core uses). `pnpm
typecheck` and `pnpm build` run both.

`pnpm test` runs two vitest projects: the workers pool (the integration suite)
and a node project (`vitest.node.config.ts`) that boots the Node assembly
(filesystem storage + temp SQLite, `AUTH=none`) and runs the cross-runtime
parity suite (`test/parity/suite.ts`) — identity, deploy+serve, db CRUD, and a
realtime round-trip over a real `WebSocket`. The import-boundary test
(`test/import-boundary.node.test.ts`) also runs in the node project; it only
reads source text (no imports), so it is runtime-agnostic.

Run the Node server locally: `pnpm dev:node` (env: `STORAGE`, `SQLITE_PATH`,
`S3_*`/`FS_ROOT`, `PORT`). Realtime is single-replica (in-process rooms); Redis
is a later opt-in.

## Invariants — breaking these breaks the product

- **Deploys are atomic.** Never write into a live `deploys/<site>/<version>/`
  prefix; always upload a fresh version then swap the D1 pointer.
- **Everything is namespaced by site**, and the site value is trusted after
  the middleware in `app.ts` validates it (`isValidSiteName`, `home` allowed).
  If you add a route that touches R2/D1/DO, derive the namespace from
  `c.var.site` — never from raw input.
- **The live-deploy pointer is cached ~5s per isolate** (`pointerCache`).
  Mutations must call `pointerCache.delete(site)`.
- **Reserved site names** live in `sites.ts` (`RESERVED`). Adding a top-level
  route (`/api`, `/auth`, `/files`, `/s`, …) means reserving its first path
  segment there too.
- **`home` is just a site.** The dashboard in `assets/` serves only while no
  deployed site named `home` exists. Don't special-case it beyond that.
- **The visitor gate is one function.** On `VISIBILITY=public` instances,
  `visitorAllowed` in `auth.ts` decides what anonymous users may touch
  (static views + `GET /api/sites`, nothing else). New routes under `/api/`,
  `/files/`, or `/auth/` are visitor-blocked by default — any other GET
  becomes publicly viewable, so check that function when adding routes.
  Visitor static responses are edge-cached (`serveSiteFor` in `app.ts`);
  members always bypass the cache.

## Working on it

- `npx wrangler dev` hot-reloads `src/` and `assets/`. Local state persists in
  `.wrangler/` (gitignored); delete it for a clean slate.
- Secrets for local dev go in `.dev.vars` (see `.dev.vars.example`).
- Tests are integration-style via `SELF.fetch` (`@cloudflare/vitest-pool-workers`);
  migrations are applied by `test/apply-migrations.ts`. Pure helpers
  (`siteFromHost`, `isValidSiteName`) are imported and tested directly.
- The local workerd may cap `compatibility_date` below today — the fallback
  warning is harmless; don't chase it.

## Adding an API surface (rare — see philosophy in the root guide)

Touch all four or it doesn't exist: route in `app.ts` → method in
`sdk/src/brisk.ts` → docs section in `assets/docs.html` → test in
`test/api.test.ts`.
