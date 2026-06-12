---
name: brisk
description: Use when creating, deploying, or iterating on a Brisk app or site. Brisk is drop-a-folder hosting with zero-config browser APIs (db, identity, ai, files, channels). Triggers on "build a brisk app/site", "deploy to brisk", "make me a … site" on a Brisk instance.
---

# Building and deploying Brisk apps

Brisk is internal hosting: drop a folder of static files, get a live URL, plus
six zero-config browser APIs. Your job is to build a small site and ship it with
the `brisk` CLI. Repo for deep dives: https://github.com/tomperi/brisk

## The constraints are the product — do not violate them

- **Six primitives, no more:** database, identity, AI, files, channels, hosting.
  If a request seems to need a seventh, it almost always composes from these.
- **No custom backend.** Everything is client-side static HTML/CSS/JS. There is
  no server you write, no API routes, no Node process. State lives in
  `brisk.db`.
- **No build step, no config, no framework required.** A folder, an
  `index.html`, and `<script src="/brisk.js"></script>`. Don't add bundlers,
  package.json, or a dev server unless the user explicitly wants one for
  authoring ergonomics — what deploys is plain files.
- **No permissions / no owners.** Everything is open to every authenticated
  teammate. Don't build auth rules, roles, or per-user access control.

If you catch yourself adding a backend, a config knob, or a seventh primitive,
stop — show how the existing pieces cover it instead.

## When to use Brisk

Good fit: internal tools, dashboards, guestbooks, voting/poll sites, multiplayer
toys, anything small that wants a database / identity / realtime without setup.

Not a fit: anything needing a real backend, custom auth/permissions, scheduled
jobs (cron), or a public site exposed to untrusted users.

## The standard flow

### 1. Get the CLI and target an instance

```sh
npm install -g @brisk/cli          # or: node path/to/brisk/cli/dist/cli.js
brisk whoami                       # confirm which instance + who you are
```

Brisk runs against an *instance* (a deployed Brisk server, or local dev). Resolve
it before deploying:

- **A real instance:** `brisk login brisk.example.com` once — it opens the
  browser, finishes login, stores a profile. Deploys are attributed to you.
- **CI / non-interactive:** set `BRISK_SERVER` and `BRISK_TOKEN`.
- **Local dev:** default is `http://localhost:8787` (run `wrangler dev` in the
  Brisk repo's `worker/`).

If it's ambiguous which instance the user means, ask before deploying.

### 2. Scaffold

```sh
brisk init my-site                 # creates brisk.json, index.html, AGENTS.md
```

`brisk init` drops an `AGENTS.md` into the folder with the full per-site SDK
reference — read it once you're in the folder.

### 3. Build the page

Plain HTML/CSS/JS. Load the SDK and use it directly — no keys, no imports:

```html
<script src="/brisk.js"></script>
<script>
  const user = await brisk.me();                 // who's looking
  const posts = brisk.db.collection('posts');    // a database
  await posts.create({ title: 'Hello' });
  posts.subscribe({ onCreate: render });         // realtime
</script>
```

For the full set of calls (db, me, ai, fs, channels), see
[references/sdk.md](references/sdk.md). One folder, `index.html` is the entry.

### 4. Ship

```sh
brisk dev      # redeploy on every save — use while iterating
brisk deploy   # ship once
```

### 5. Verify — always

```sh
brisk open     # open the deployed URL
```

Load the URL and confirm the page renders and a `brisk.*` call actually works.
Never report "done" without seeing it live.

### 6. Remix and inspect existing sites

```sh
brisk list             # everything deployed on the instance
brisk pull <site> dir  # download a site's source to remix it
```

## Escape hatches (when this skill isn't enough)

- `brisk --help` — the full CLI command + option list.
- The folder's generated `AGENTS.md` — full per-site SDK reference.
- `/docs` on any instance — the live one-page SDK reference.
- https://github.com/tomperi/brisk — README + architecture; websearch it for
  deeper questions (wire protocol, worker internals, deploying the platform).
