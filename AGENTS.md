# Brisk — agent guide

Internal hosting platform on Cloudflare: deploy a folder → get a site, plus six
zero-config browser APIs (db, identity, ai, files, channels, hosting). Product
and architecture live in [README.md](README.md) — read its Architecture section
before touching the worker.

## Workspace

pnpm monorepo. Per-package guides hold the non-obvious details — read the one
for the package you're changing:

| Package     | What                                                                  | Guide                                |
| ----------- | --------------------------------------------------------------------- | ------------------------------------ |
| `worker/`   | The whole platform: one Cloudflare Worker + R2 + D1 + Durable Objects | [worker/AGENTS.md](worker/AGENTS.md) |
| `sdk/`      | Zero-dep browser client, served at `/brisk.js`                        | [sdk/AGENTS.md](sdk/AGENTS.md)       |
| `cli/`      | `brisk` command: deploy, dev, pull, login + profiles; zero deps       | [cli/AGENTS.md](cli/AGENTS.md)       |
| `examples/` | Complete deployable sites; keep them tiny and dependency-free         | —                                    |

The realtime wire protocol is shared between worker and sdk:
[docs/realtime-protocol.md](docs/realtime-protocol.md).

## Commands

```sh
pnpm install
pnpm build            # sdk → worker/assets/brisk.js, cli → dist (run after sdk/cli edits)
pnpm test             # worker integration tests (vitest + workers pool)
pnpm typecheck
pnpm format           # prettier; CI enforces format:check

# run the platform locally
cd worker
npx wrangler d1 migrations apply brisk --local   # once
npx wrangler dev                                 # http://localhost:8787, hot-reloads

# smoke an end-to-end change
BRISK_SERVER=http://localhost:8787 node cli/dist/cli.js deploy examples/guestbook
```

## Conventions

- TypeScript strict everywhere; ESM with `.js` import suffixes in `cli/`
  (NodeNext), extensionless in `worker/`/`sdk/` (bundler resolution).
- Dependencies are a last resort. `sdk/` and `cli/` have zero runtime deps;
  the worker has three (`hono`, `@anthropic-ai/sdk`, plus types). Keep it so.
- Comments explain constraints and intent, never restate the code.
- Semantic commits (`feat(worker): …`, `fix(cli): …`), atomic, no bodies
  unless genuinely needed.
- User-facing changes get a `CHANGELOG.md` entry in the same PR — a line under
  `## [Unreleased]` (Keep a Changelog: Added/Changed/Fixed). CI enforces this
  for `worker/`, `sdk/`, and `cli/` `src/` changes; apply the `no-changelog`
  label to skip pure-internal churn. Releases tag `vX.Y.Z` and `release.yml`
  cuts the notes from there.

## Product philosophy (it constrains code review too)

Six primitives, no more. No permissions, no custom backends, no cron jobs.
When a change adds a knob, a config option, or a seventh primitive, the
default answer is no — show how the existing pieces cover it. The trust model
(everything open to every authenticated teammate) is intentional; don't "fix"
it. The one carve-out is the deploy `owner`: a self-asserted, spoofable label
and overwrite footgun-guard, never access control — it gates only the
deploy-over-someone-else 409 (bypass with `--force`); reads and every other
write stay open to every authenticated teammate.
