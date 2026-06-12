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
| `src/auth.ts`  | Google OAuth, session cookies, dev identity, deploy-token bearer                                    |
| `src/ai.ts`    | Anthropic/OpenAI proxy; provider picked by configured key                                           |
| `assets/`      | The dashboard (the built-in `home` site) + generated `brisk.js`                                     |
| `migrations/`  | D1 schema; add new numbered files, never edit applied ones                                          |

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
