# cli/ — the `brisk` command

Zero runtime dependencies (Node ≥ 20.12 globals: `fetch`, `FormData`, `File`,
recursive `fs` APIs). Compiled with `tsc` to `dist/`; `pnpm build` after edits,
then run as `node cli/dist/cli.js …`.

## Map

| File               | Owns                                                                 |
| ------------------ | -------------------------------------------------------------------- |
| `src/cli.ts`       | Arg parsing (`node:util` parseArgs), help, command routing           |
| `src/commands.ts`  | All commands; `deploy` is the core (multipart upload of a folder)    |
| `src/config.ts`    | Server/token resolution: flag > env > `brisk.json` > localhost       |
| `src/templates.ts` | What `brisk init` scaffolds — including the _site-level_ `AGENTS.md` |
| `src/ui.ts`        | ANSI helpers, byte/time formatting                                   |

## Non-obvious

- **`templates.ts` ships SDK documentation.** The `AGENTS.md` it generates
  teaches coding agents the `brisk.*` API inside every initialized site
  folder. Any SDK surface change must be reflected there (and in
  `worker/assets/docs.html`).
- Auth is just `BRISK_TOKEN` → `Authorization: Bearer` on every request
  (`config.ts`); needed only when the server runs `AUTH=google`.
- Manual e2e loop: `wrangler dev` in one terminal, then
  `BRISK_SERVER=http://localhost:8787 node cli/dist/cli.js deploy examples/guestbook`.
- Deploy file paths travel as the `File.name` of each multipart part —
  forward slashes, relative, validated server-side.
