# cli/ — the `brisk` command

Zero runtime dependencies (Node ≥ 20.12 globals: `fetch`, `FormData`, `File`,
recursive `fs` APIs). Compiled with `tsc` to `dist/`; `pnpm build` after edits,
then run as `node cli/dist/cli.js …`.

## Map

| File               | Owns                                                                 |
| ------------------ | -------------------------------------------------------------------- |
| `src/cli.ts`       | Arg parsing (`node:util` parseArgs), help, command routing           |
| `src/commands.ts`  | All commands; `deploy` is the core, `login` runs the localhost flow  |
| `src/config.ts`    | Profiles (`~/.config/brisk/config.json`) + connection resolution     |
| `src/templates.ts` | What `brisk init` scaffolds — including the _site-level_ `AGENTS.md` |
| `src/ui.ts`        | ANSI helpers, byte/time formatting                                   |

## Non-obvious

- **`templates.ts` ships SDK documentation.** The `AGENTS.md` it generates
  teaches coding agents the `brisk.*` API inside every initialized site
  folder. Any SDK surface change must be reflected there (and in
  `worker/assets/docs.html` and `skills/brisk/references/sdk.md`).
- **Connection resolution lives in one place** (`resolveConnection` in
  `config.ts`): `--profile`/`BRISK_PROFILE` > `--server`/`BRISK_SERVER` >
  `brisk.json` `server` > active profile > localhost. When a server is given
  without a profile, the token comes from `BRISK_TOKEN` or a profile whose
  server matches. Don't resolve servers or tokens anywhere else.
- **`brisk login`** starts a localhost listener, opens
  `<server>/auth/cli?port&state`; the worker (see `worker/src/auth.ts`)
  redirects back with a personal JWT — or `open=1` on AUTH=none instances,
  in which case the profile stores no token. Validate the `state` echo.
- Manual e2e loop: `wrangler dev` in one terminal, then
  `BRISK_SERVER=http://localhost:8787 node cli/dist/cli.js deploy examples/guestbook`.
- Deploy file paths travel as the `File.name` of each multipart part —
  forward slashes, relative, validated server-side.
- **Deploy ownership is a footgun guard, not a permission.** `deploy` asserts
  an identity via `x-brisk-username` (resolved `--username` > `BRISK_USERNAME` >
  profile `username`; spoofable by design). Overwriting a site owned by someone
  else 409s with `code: 'owned'`; the CLI then prompts on a TTY, or errors and
  tells you to `--force`/`BRISK_FORCE=1` when non-interactive (agents/CI never
  hang on stdin). It labels sites, never gates reads or other writes.
