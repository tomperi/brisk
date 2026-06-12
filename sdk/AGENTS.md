# sdk/ — the browser client

One file (`src/brisk.ts`), zero dependencies, bundled by esbuild to an IIFE
that defines the `brisk` global. Sites load it with
`<script src="/brisk.js"></script>`; that ergonomic ceiling (one tag, no
imports, no build step on the site's side) is the whole point — protect it.

## Non-obvious mechanics

- **The build output is what the worker serves.** `pnpm build` writes
  `dist/brisk.js` and copies it to `worker/assets/brisk.js` (gitignored).
  An SDK edit does nothing until you rebuild.
- **Site detection**: on `foo.<host>` the server infers the site from the
  Host header; on `/s/<site>/…` pages the SDK sends `x-brisk-site` (HTTP)
  and `?site=` (websocket — browsers can't set headers on upgrades).
- **One shared websocket**, lazy, with exponential backoff reconnect that
  replays all subscriptions and channel joins
  ([wire protocol](../docs/realtime-protocol.md)). `db:unsub`/`leave` are
  skipped when disconnected — a dead socket has no server state to undo.
- API calls are same-origin relative paths; there is no configuration, and
  there must never need to be.

## Rules

- No runtime dependencies, no framework, no async setup step. New surface
  area needs a matching worker route, docs entry, and test (see
  `worker/AGENTS.md` → Adding an API surface).
- Public API stays promise-based and tiny; prefer extending an existing
  namespace over adding a new one.
