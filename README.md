# Brisk

**Drop a folder, get a site.**

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

No frameworks, no deploy pipelines, no config files, no permissions. It runs
entirely on Cloudflare (one Worker + R2 + D1 + Durable Objects) and costs
approximately nothing.

> **The trust model is the feature.** Brisk is for _internal_ use, behind a
> login. Every site is visible and writable by every teammate. That's what
> deletes all the complexity: no site owners, no API keys, no spam. Read
> [Philosophy](#philosophy) before deploying it anywhere public.

## Quickstart (local)

```sh
git clone <this repo> && cd brisk
pnpm install && pnpm build

# terminal 1 — the platform
cd worker
npx wrangler d1 migrations apply brisk --local
npx wrangler dev                       # http://localhost:8787

# terminal 2 — ship a site
node cli/dist/cli.js init my-site
node cli/dist/cli.js deploy my-site    # → http://localhost:8787/s/my-site/
```

Open http://localhost:8787 for the dashboard. `*.localhost` subdomains work
too: http://my-site.localhost:8787.

## Deploying to Cloudflare

You need a Cloudflare account and, for subdomain URLs, a domain on it.

```sh
cd worker

# 1. Create the resources
npx wrangler d1 create brisk          # paste the id into wrangler.jsonc
npx wrangler r2 bucket create brisk

# 2. Apply the schema
npx wrangler d1 migrations apply brisk --remote

# 3. Ship it
pnpm --filter @brisk/sdk build        # bundles the SDK into worker assets
npx wrangler deploy
```

That gives you path-mode URLs (`https://brisk.<account>.workers.dev/s/foo/`)
with no auth, suitable for a private network. For the full experience:

### Wildcard subdomains

Add routes in `wrangler.jsonc` (see the comment there) so `foo.brisk.example.com`
serves site `foo`:

```jsonc
"routes": [
  { "pattern": "brisk.example.com", "custom_domain": true },
  { "pattern": "*.brisk.example.com/*", "zone_name": "example.com" }
],
"vars": { "BASE_HOST": "brisk.example.com", ... }
```

You'll also need a wildcard DNS record (`*.brisk` → CNAME to the apex) and a
[Total TLS or advanced certificate](https://developers.cloudflare.com/ssl/edge-certificates/)
covering `*.brisk.example.com`.

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

3. In `wrangler.jsonc` set `"AUTH": "google"` and, to restrict who gets in,
   `"ALLOWED_EMAIL_DOMAINS": "yourco.com"`.

Browsers get redirected to Google; the CLI authenticates with
`BRISK_TOKEN=<DEPLOY_TOKEN>`. With `AUTH: "none"` (the default) everyone is a
trusted dev user — only do that on a network you trust.

### AI

```sh
npx wrangler secret put ANTHROPIC_API_KEY   # and/or OPENAI_API_KEY
```

Keys stay on the server; sites call `brisk.ai.chat(...)` with no setup.

## The CLI

```sh
npm install -g @brisk/cli       # or run from this repo: node cli/dist/cli.js

brisk init [name]               # scaffold a folder (brisk.json, index.html, AGENTS.md)
brisk deploy [dir]              # upload, get a URL
brisk dev [dir]                 # redeploy on every save
brisk list                      # everything on the instance
brisk open [site]               # open in the browser
brisk pull <site> [dir]         # download any site's source to remix it
```

Configure with `BRISK_SERVER` (or `server` in `brisk.json`) and `BRISK_TOKEN`.
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

The whole platform is one Worker and four Cloudflare primitives:

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
  the site's pointer row in D1 swaps. A site is never served half-updated, and
  the previous version is cleaned up after the swap.
- **Realtime is one Durable Object per site** (websocket hibernation, so idle
  rooms cost nothing). It fans out db change events, channel messages, and
  presence.
- **Identity is platform-level**: Google OAuth on the apex, JWT session cookie
  scoped to the parent domain, every request arrives pre-authenticated — the
  same trick as putting a VM behind an identity-aware proxy.

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
pnpm test           # worker integration tests (vitest + workers pool)
pnpm typecheck
pnpm format
```

The repo is a pnpm workspace: [`worker/`](worker) (the platform),
[`sdk/`](sdk) (browser client served at `/brisk.js`), [`cli/`](cli), and
[`examples/`](examples).

## License

[MIT](LICENSE)
