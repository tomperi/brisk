# Brisk

**Drop a folder, get a site.**

![Deploying to Brisk: dragging a folder onto the dashboard names the site, records who shipped it, and puts it live at my-site.usebrisk.dev — or do the same from the terminal with the brisk CLI.](docs/media/brisk-launch.gif)

Brisk is an open-source internal hosting platform inspired by Shopify's
[Quick](https://shopify.engineering/quick). Anyone on your team can upload a
folder of HTML and get a live URL in seconds, plus a zero-config browser API
for the things every little site eventually wants:

```html
<script src="/brisk.js"></script>
<script>
  const posts = brisk.db.collection('posts');          // a database
  await posts.create({ title: 'Hello' });
  posts.subscribe({ onCreate: render });               // realtime updates

  const user = await brisk.me();                       // identity, no login flow
  const res  = await brisk.ai.chat('Summarize: …');    // AI, no API keys
  const file = await brisk.fs.upload(input.files);     // file storage
  brisk.channel('lobby').send({ hi: 1 });              // multiplayer websockets
</script>
```

No frameworks, no deploy pipelines, no config files, no permissions.

It runs two ways from the same code: on **Cloudflare** (one Worker + R2 + D1 +
Durable Objects), which costs [approximately nothing](#cost), or
**[self-hosted](#self-hosting-docker-compose-kubernetes)** on any Node box —
Docker, Compose, or Kubernetes — with SQLite plus a disk or an S3 bucket. Same
folder, same six APIs, no code changes.

**What you get:**

- **Instant hosting** — `brisk deploy` any folder; it's live at
  `https://<name>.<your-host>/` in about a second. Deploys are atomic, names
  are first come, and anyone can overwrite anything.
- **Six backend primitives**, callable from any page with zero setup:
  database, identity, AI, file storage, realtime channels, and the static
  hosting itself.
- **A dashboard** at the apex domain listing every site on the instance —
  a living changelog of what your team is making — plus a one-page SDK
  reference at `/docs`. Signed-in members can also deploy by dragging a
  folder straight onto it (confetti included).
- **A CLI** with watch-mode deploys (`brisk dev`) and the ability to download
  any site's source (`brisk pull`) to remix it.
- **One login for everything** (optional): Google OAuth on the apex domain
  with a session cookie that covers every site subdomain.

> **The trust model is the feature.** Brisk is for _internal_ use, behind a
> login. Every site is visible and writable by every teammate. That's what
> deletes all the complexity: no site owners, no API keys, no spam. Read
> [Philosophy](#philosophy) before deploying it anywhere public.

## Running locally

Everything runs on your machine via `wrangler dev` (Cloudflare's local
runtime) — no Cloudflare account needed. Prerequisites: Node ≥ 22, pnpm.

```sh
git clone <this repo> && cd brisk
pnpm install && pnpm build

# terminal 1 — the platform
cd worker
npx wrangler d1 migrations apply brisk --local   # creates the local database
npx wrangler dev                                 # http://localhost:8787

# terminal 2 — ship a site
node cli/dist/cli.js init my-site
node cli/dist/cli.js deploy my-site    # → http://localhost:8787/s/my-site/
```

Open http://localhost:8787 for the dashboard. `*.localhost` subdomains work
too: http://my-site.localhost:8787. Local state (R2 objects, the D1 database,
Durable Objects) lives under `worker/.wrangler/` and survives restarts.

Optional local extras go in `worker/.dev.vars` (see
[`.dev.vars.example`](worker/.dev.vars.example)) — e.g. an `ANTHROPIC_API_KEY`
to exercise `brisk.ai` locally.

## Deploying to Cloudflare

You need a Cloudflare account and, for subdomain URLs, a domain on it.

```sh
cd worker
export CLOUDFLARE_ACCOUNT_ID=...      # or run `wrangler login` (single account)

# 1. Create the resources
npx wrangler d1 create brisk          # paste the id into wrangler.jsonc
npx wrangler r2 bucket create brisk

# 2. Apply the schema
npx wrangler d1 migrations apply brisk --remote

# 3. Ship it
pnpm --filter @usebrisk/sdk build        # bundles the SDK into worker assets
npx wrangler deploy
```

That gives you path-mode URLs (`https://brisk.<account>.workers.dev/s/foo/`)
with no auth, suitable for a private network. For the full experience:

### Configuration

`wrangler.jsonc` carries no deployment-specific config — no account id, no
domain, no allowlist. That keeps the repo clean and lets you run one codebase
across many instances. Three places hold the rest:

- **`database_id`** is the one value that must live in `wrangler.jsonc`
  (wrangler needs it to deploy). Paste it in from step 1. Any value works for
  local dev and tests; only remote deploys need the real one. To keep your real
  id from ever being committed: `git update-index --skip-worktree worker/wrangler.jsonc`.
- **`account_id`** comes from the `CLOUDFLARE_ACCOUNT_ID` environment variable.
- **Instance vars** are set as **Variables in the Cloudflare dashboard**
  (Workers & Pages → your worker → Settings → Variables and Secrets). They are
  read at runtime and every one is optional, defaulting in code to a safe
  path-only, no-auth, private instance:

  | Variable                | Purpose                                                       | Default               |
  | ----------------------- | ------------------------------------------------------------- | --------------------- |
  | `BASE_HOST`             | host sites hang off (`foo.<BASE_HOST>`)                       | path-only (`/s/foo/`) |
  | `AUTH`                  | `google` for OAuth, else trusted-network dev identity         | `none`                |
  | `ALLOWED_EMAILS`        | exact emails admitted through OAuth (comma-separated)         | anyone                |
  | `ALLOWED_EMAIL_DOMAINS` | whole domains admitted through OAuth                          | anyone                |
  | `VISIBILITY`            | `public` for view-only demo mode                              | `private`             |
  | `DEPLOY_HISTORY`        | `on` keeps every published version (history, future rollback) | `off`                 |

  `keep_vars: true` in `wrangler.jsonc` stops `wrangler deploy` from wiping
  dashboard-set vars. Locally, `wrangler dev` reads them from `.dev.vars` (see
  [`.dev.vars.example`](worker/.dev.vars.example)) instead.

### Wildcard subdomains

Set `BASE_HOST` to `brisk.example.com` (a dashboard variable — see
[Configuration](#configuration)), then attach the domain **in the Cloudflare
dashboard** (Workers & Pages → your worker → Settings → Domains & Routes):

- custom domain: `brisk.example.com`
- route: `*.brisk.example.com/*` (zone: `example.com`)

Don't put these in `wrangler.jsonc` as a `routes` key: when routes exist in
the config, `wrangler dev` rewrites every local request's Host to the
production zone — `foo.localhost` subdomains stop working and the API hands
out production URLs from local dev. Dashboard-attached domains persist across
deploys, so this is one-time setup. Site links adapt automatically to however
the instance is reached: subdomain URLs via `BASE_HOST`, `/s/<site>/` URLs
everywhere else, localhost included.

You'll also need a wildcard DNS record (`*.brisk` → CNAME to the apex) and a
[Total TLS or advanced certificate](https://developers.cloudflare.com/ssl/edge-certificates/)
covering `*.brisk.example.com`. That second-level wildcard is the one part of
Brisk that isn't free (~$10/mo) — putting sites one level deep instead
(`BASE_HOST=example.com`, sites at `foo.example.com`) keeps them on free
Universal SSL. See [Cost](#cost).

### Google login (one login for every site)

Brisk's answer to "identity-aware proxy": optional Google OAuth on the apex
domain, with the session cookie scoped to `.brisk.example.com` so a single
login covers every site subdomain.

1. Create an OAuth client (web application) in Google Cloud Console with
   redirect URI `https://brisk.example.com/auth/callback`.
2. Configure the worker:

```sh
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET     # any long random string
npx wrangler secret put DEPLOY_TOKEN       # token the CLI will use
```

3. Set the auth vars in the dashboard ([Configuration](#configuration)):
   `AUTH=google`, and restrict who gets in with `ALLOWED_EMAIL_DOMAINS=yourco.com`
   for a company, or `ALLOWED_EMAILS=you@gmail.com` for a personal instance
   (never allowlist all of `gmail.com`). Either list admits.

   > ⚠️ **With both lists empty, anyone who completes a Google login is admitted.**
   > Always set one before going public.

Browsers get redirected to Google. The CLI logs in as a real person:

```sh
brisk login brisk.example.com    # opens the browser, stores a personal token
```

Deploys are then attributed to your email on the dashboard. The
`DEPLOY_TOKEN` secret is for CI (`BRISK_TOKEN=<DEPLOY_TOKEN>`, shows up as
`ci@brisk`). With `AUTH: "none"` (the default) everyone is a trusted dev
user — only do that on a network you trust. The worker refuses to serve when
`AUTH` is unset on a public host, warns loudly if you run an explicit
`AUTH=none` there, and `brisk deploy` confirms before pushing to an open
instance — so you can't expose one silently.

#### Auth at a glance

| `AUTH`           | `VISIBILITY`        | Viewing sites                      | Deploys + APIs (db / ai / files / realtime) |
| ---------------- | ------------------- | ---------------------------------- | ------------------------------------------- |
| `none` (default) | —                   | everyone                           | everyone, as the dev identity               |
| `google`         | `private` (default) | members only                       | members + CI token                          |
| `google`         | `public`            | **anyone**, read-only, edge-cached | members + CI token                          |

Members are whoever passes `ALLOWED_EMAILS` / `ALLOWED_EMAIL_DOMAINS`. Three
credentials exist: the browser session cookie (7 days, covers every site
subdomain), the personal CLI token from `brisk login` (90 days, attributed to
you), and the optional `DEPLOY_TOKEN` secret (CI, attributed as `ci@brisk`;
leave it unset and that path simply doesn't exist).

### AI

```sh
npx wrangler secret put ANTHROPIC_API_KEY   # and/or OPENAI_API_KEY
```

Keys stay on the server; sites call `brisk.ai.chat(...)` with no setup.

### Demo mode (public, view-only)

Want strangers to be able to _see_ your instance without being able to touch
it? Set `VISIBILITY=public` alongside `AUTH=google` ([Configuration](#configuration)):

- **Visitors (no login)** can browse the dashboard, the docs, and every
  deployed site. Their static requests are edge-cached (`max-age=300`), so a
  busy demo costs ~zero R2/D1 operations — at the price of deploys taking up
  to 5 minutes to reach signed-out eyes.
- **Everything else is a 401 for visitors**: the database (reads included —
  the API has no rate limiting, so don't give the internet a free query
  button), AI, uploads, websockets, deploys, site deletion, and CLI token
  minting. Demo pages render; their `brisk.*` calls fail fast with a clear
  error, and the SDK stops retrying rejected websockets instead of hammering
  the worker.
- **Members** (you, via `ALLOWED_EMAILS`) sign in with the dashboard's
  "sign in" button or `brisk login` and get the full platform, uncached.

Before publishing, spend two minutes in the Cloudflare dashboard on your
zone — both are free and block abusive traffic _before_ it bills as Worker
requests:

1. **Security → WAF → Rate limiting rules**: one rule on
   `(http.host wildcard "*your-brisk-host")`, e.g. block 10s when an IP
   exceeds ~100 requests.
2. **Security → Bots**: enable Bot Fight Mode.

Also leave `DEPLOY_TOKEN` unset unless you have CI — an unset secret means
that authentication path simply doesn't exist.

## Self-hosting (Docker, Compose, Kubernetes)

Cloudflare is the reference target, not a requirement. The same Hono core runs
as a plain Node server, with the platform's seams — storage, database, rooms,
assets, cache — bound to SQLite, the filesystem or S3, and in-process
websockets instead. Nothing above the seam knows which one it's on, so the SDK,
the dashboard, and every deployed site behave identically.

The fastest way in is the wizard, which asks four questions and writes the
config for whichever target you picked:

![npm create brisk: the wizard asks where Brisk will run, which auth mode, an allowed Google email domain, and a storage backend — then writes docker-compose.yml and .env.](docs/media/create-brisk.gif)

```sh
npm create brisk
```

Or go straight to the artifacts in [`deploy/`](deploy):

```sh
# a single VM
cp deploy/.env.example deploy/.env      # set AUTH, BASE_HOST, secrets…
docker compose -f deploy/docker-compose.yml up -d

# Kubernetes
helm install brisk deploy/helm/brisk \
  --set config.baseHost=brisk.example.com \
  --set config.auth=google \
  --set secrets.sessionSecret=$(openssl rand -hex 32)
```

Storage is filesystem-plus-SQLite on one volume by default (no external
services); set `config.storage=s3` to put objects in any S3-compatible bucket.
Realtime lives in-process, so the chart pins a single replica and refuses to
render with more — a second pod would come up healthy and silently serve its
own rooms. [`deploy/README.md`](deploy/README.md) has the full environment
variable reference, the egress lock, and the backup story (**the volume is the
database** — nothing here replicates it for you).

## Cost

Brisk is built to live inside Cloudflare's free tier. At personal or small-team
scale the platform itself costs **nothing** — the only things that can land on a
bill are an optional wildcard certificate and, if sites use it, AI tokens.

What the free tier covers (per Cloudflare account):

| Product         | Brisk uses it for               | Free tier                                           |
| --------------- | ------------------------------- | --------------------------------------------------- |
| Workers         | every request                   | 100k requests/day, 10 ms CPU/request                |
| R2              | site files + `brisk.fs` uploads | 10 GB stored, 1M writes + 10M reads/mo, zero egress |
| D1              | the `sites` and `docs` tables   | 5 GB, 5M row-reads/day, 100k row-writes/day         |
| Durable Objects | one realtime room per site      | included on the free plan (SQLite-backed)           |

Realtime doesn't push you onto a paid plan: `SiteRoom` is a SQLite-backed
Durable Object (free-plan eligible) using WebSocket hibernation, so idle
channels bill nothing — you only pay when messages actually flow. 100k
requests/day is plenty of headroom for an internal instance, and the demo-mode
edge cache above keeps signed-out traffic off your R2/D1 quotas entirely. Cross
the request cap and you're on
[Workers Paid](https://developers.cloudflare.com/workers/platform/pricing/)
($5/mo), which turns the daily caps into a forgiving monthly pool.

**The one catch is wildcard TLS.** Free Universal SSL covers a domain's apex and
_one_ level of subdomain. Sites one level deep — `foo.example.com` with
`BASE_HOST=example.com` — are covered for free. Nest them under a label —
`foo.brisk.example.com` — and that second-level wildcard needs an
[advanced certificate](https://developers.cloudflare.com/ssl/edge-certificates/advanced-certificate-manager/)
(~$10/mo). The cheap fix is a dedicated domain: register one (~$10/**year** at
Cloudflare Registrar, at cost), point `BASE_HOST` at its apex, and every
`*.yourdomain` site gets free TLS. Path-mode URLs (`/s/foo/`) sidestep the
question entirely.

**AI is pass-through.** `brisk.ai` calls bill against your own Anthropic/OpenAI
key at provider rates — the only cost here with no ceiling, so set a spend limit
on the provider side if your sites lean on it.

## The CLI

```sh
npm install -g @usebrisk/cli       # or run from this repo: node cli/dist/cli.js

brisk init [name]               # scaffold a folder (brisk.json, index.html, AGENTS.md)
brisk deploy [dir]              # upload, get a URL
brisk dev [dir]                 # redeploy on every save
brisk list                      # everything on the instance
brisk open [site]               # open in the browser
brisk pull <site> [dir]         # download any site's source to remix it

brisk login [server]            # log in to an instance, creates a profile
brisk whoami                    # who you are, where
brisk profiles                  # list profiles; `brisk profile use <name>` switches
```

Profiles work like AWS profiles: one per Brisk instance you use, stored in
`~/.config/brisk/config.json`. `brisk login brisk.example.com` opens the
browser, finishes the instance's Google login, and stores a personal token —
deploys are then attributed to _you_. Every command takes `--profile <name>`
(or `BRISK_PROFILE`); a repo can pin its instance with `server` in
`brisk.json` and the CLI picks the matching profile automatically. For CI,
skip profiles entirely: `BRISK_SERVER` + `BRISK_TOKEN`.

`brisk init` also drops an `AGENTS.md` so coding agents immediately know the
SDK — "make me a lunch-voting site" works out of the box.

## The SDK

Full reference lives on your instance at `/docs`. The shape of it:

| Namespace                      | What you get                                                              |
| ------------------------------ | ------------------------------------------------------------------------- |
| `brisk.db.collection(name)`    | Schemaless JSON docs: `create / list / get / update / delete / subscribe` |
| `brisk.me()`                   | `{ email, name, picture }` of whoever is looking at the page              |
| `brisk.ai.chat(prompt, opts?)` | LLM calls proxied through the server's keys                               |
| `brisk.fs.upload(files)`       | Permanent URLs for user uploads                                           |
| `brisk.channel(name)`          | Realtime messaging + presence per site                                    |

Everything is namespaced per site. Docs and channels of one site are invisible
to another, purely as a convenience (it's all one happy trust bubble).

## Architecture

The whole platform is one app behind six seams. On Cloudflare those seams are
a Worker and four Cloudflare primitives:

![Brisk architecture: site subdomains pass through optional Google OAuth into one Cloudflare Worker, which serves static files from R2 and routes /api/* to D1, R2, Durable Objects, the AI proxy, identity, and hosting.](worker/assets/architecture.png)

```
foo.brisk.example.com ─┐
bar.brisk.example.com ─┤→ Worker ──→ /s/… static files ──→ R2  (versioned deploys)
brisk.example.com ─────┘    │
  (Google OAuth here,       ├→ /api/db, /api/sites ──────→ D1  (docs + deploy pointers)
   cookie covers *.domain)  ├→ /api/ws ──────────────────→ Durable Object per site
                            ├→ /api/ai ──────────────────→ Anthropic / OpenAI (server keys)
                            └→ /api/fs, /files ──────────→ R2  (uploads)
```

- **Deploys are atomic**: files upload under a fresh version prefix in R2, then
  the site's pointer row in D1 swaps. A site is never served half-updated. By
  default the previous version is deleted after the swap, keeping storage
  bounded; set `DEPLOY_HISTORY=on` to retain every version for history and
  future rollback.
- **Realtime is one Durable Object per site** (websocket hibernation, so idle
  rooms cost nothing). It fans out db change events, channel messages, and
  presence.
- **Identity is platform-level**: Google OAuth on the apex, JWT session cookie
  scoped to the parent domain, every request arrives pre-authenticated — the
  same trick as putting a VM behind an identity-aware proxy.
- **The runtime is a seam, not an assumption.** Storage, database, rooms,
  assets, cache, and background work each sit behind an interface
  ([`worker/src/platform`](worker/src/platform)); the core imports the
  interface, never a vendor. The Cloudflare assembly binds them to R2, D1, and
  Durable Objects; the Node assembly binds them to S3-or-disk, SQLite, and
  in-process websockets. The same integration suite runs against both, so
  "works on Cloudflare" and "works self-hosted" are the same claim.

### Request flow

1. A request arrives; the Worker derives the **site** from the subdomain, the
   `/s/<site>/` path prefix, or the SDK's `x-brisk-site` header. The bare host
   is just a site named `home` (the built-in dashboard, until someone deploys
   over it).
2. The **auth middleware** resolves a user: dev identity (`AUTH=none`),
   session cookie, or CLI bearer token. Unauthenticated browsers bounce to
   Google; APIs get a 401.
3. Static requests look up the site's live deploy pointer (cached ~5s per
   isolate) and stream the file from R2, resolving `/about` → `about.html`
   and directory indexes. API requests hit D1/R2 directly; `/api/ws` upgrades
   are handed to the site's Durable Object with the user attached.

### Storage layout

| Where                             | What                                                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| R2 `deploys/<site>/<version>/…`   | site files; one immutable prefix per deploy                                                                     |
| R2 `uploads/<site>/<id>/<name>`   | `brisk.fs` uploads, immutable URLs                                                                              |
| D1 `sites`                        | one row per site: live-deploy pointer, size, who deployed last                                                  |
| D1 `deploys`                      | one row per published version: version number, size, who; pruned to the live version unless `DEPLOY_HISTORY=on` |
| D1 `docs`                         | the document store: `(site, collection, id) → JSON`                                                             |
| Durable Object `SiteRoom(<site>)` | websocket fan-out: db events, channel messages, presence                                                        |

Nothing else persists. Deleting a site removes its row, docs, deploys, and
uploads.

## Philosophy

Stolen proudly from Quick:

- **Keep it simple.** Six primitives, no more. Feature requests are usually
  demos waiting to happen with the existing pieces.
- **No permissions.** No site owners. Want to update a site? Overwrite it.
  Want a subdomain? Take it. Internal trust makes "should we add a
  leaderboard?" a _hell yes_ instead of a security review.
- **The constraints are the point.** No custom backends, no cron jobs, no
  build steps. A folder of files, a URL, and six APIs.

## Development

```sh
pnpm install
pnpm build          # sdk → worker assets, cli → dist
pnpm test           # every package: worker (workers pool + Node parity), create-brisk
pnpm typecheck      # both runtimes — the workers and Node tsconfigs
pnpm format
```

The repo is a pnpm workspace: [`worker/`](worker) (the platform — both
assemblies), [`sdk/`](sdk) (browser client served at `/brisk.js`),
[`cli/`](cli), [`create-brisk/`](create-brisk) (the `npm create brisk`
wizard), [`deploy/`](deploy) (Dockerfile, Compose stack, Helm chart), and
[`examples/`](examples).

### Releasing

`@usebrisk/cli` and `@usebrisk/sdk` publish to npm in lockstep. Bump both to
the same version, then push a matching tag:

```sh
git tag v0.1.1 && git push origin v0.1.1
```

The [`release`](.github/workflows/release.yml) workflow builds, runs the CI
gates, publishes both packages, and cuts a GitHub release. It fires only on
`v*` tags — nothing publishes on ordinary pushes. Requires an `NPM_TOKEN`
repo secret (an npm automation token scoped to the `@usebrisk` org).

## License

[MIT](LICENSE)
