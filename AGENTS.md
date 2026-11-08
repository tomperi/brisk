# Brisk — agent guide

Internal hosting platform on Cloudflare: deploy a folder → get a site, plus six
zero-config browser APIs (db, identity, ai, files, channels, hosting). Product
and architecture live in [README.md](README.md) — read its Architecture section
before touching the worker.

## Workspace

pnpm monorepo. Per-package guides hold the non-obvious details — read the one
for the package you're changing:

| Package         | What                                                                  | Guide                                            |
| --------------- | --------------------------------------------------------------------- | ------------------------------------------------ |
| `worker/`       | The whole platform: one Cloudflare Worker + R2 + D1 + Durable Objects | [worker/AGENTS.md](worker/AGENTS.md)             |
| `sdk/`          | Zero-dep browser client, served at `/brisk.js`                        | [sdk/AGENTS.md](sdk/AGENTS.md)                   |
| `cli/`          | `brisk` command: deploy, dev, pull, login + profiles; zero deps       | [cli/AGENTS.md](cli/AGENTS.md)                   |
| `create-brisk/` | `npm create brisk` — scaffolds an instance's deployment config        | [create-brisk/AGENTS.md](create-brisk/AGENTS.md) |
| `examples/`     | Complete deployable sites; keep them tiny and dependency-free         | —                                                |

The realtime wire protocol is shared between worker and sdk:
[docs/realtime-protocol.md](docs/realtime-protocol.md).

**Adding an instance env var — touch all of these, or it silently doesn't
exist.** Every field on `Env` is optional, so a missed step is `undefined` at
runtime, not a compile error:

`worker/src/env.ts` (`Env`) → `worker/.dev.vars.example` → `README.md`'s config
table → the deployment config in `deploy/` → `create-brisk/src/answers.ts`
(`CONFIG_VARS` / `SECRET_VARS`) and every emitter in `create-brisk/src/generate.ts`.

`create-brisk`'s `test/env-parity.test.ts` fails the build if `Env` and that last
step drift, which is the only link in the chain a machine checks for you.

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
write stay open to every authenticated teammate. Site tokens (`worker/src/tokens.ts`)
are the other: they limit a machine credential to named sites and CRUD scopes,
never a teammate — any member can create, disable or delete any token.
