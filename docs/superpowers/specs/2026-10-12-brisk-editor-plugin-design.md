# In-browser editing: the `editor` plugin — design

**Date:** 2026-10-12
**Status:** Parked (research complete, not scheduled)

## Problem

Fixing a typo on a deployed Brisk site today means: find the folder (or
`brisk pull` it), edit, `brisk deploy`. For the people Brisk is for — teammates
who dropped a folder on the dashboard and never opened a terminal — that loop
doesn't exist. They open the site, see the mistake, and have no way to act on
it where they're looking at it.

The goal: open a site, see its content, edit it live, save, and the underlying
site changes. The "overwrite anything" trust model already permits this; nothing
in the product exposes it from the browser.

## Feasibility summary

Feasible, and nearly every building block exists. What's there:

| Need                         | Exists as                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Read a site's source         | `GET /api/sites/:name/files` + `GET /api/sites/:name/raw/*` (what `brisk pull` uses; member-only)                 |
| Write from the browser       | `POST /api/deploy/:name` multipart — the dashboard's drag-and-drop (`worker/assets/drop.js`) already calls it      |
| Inject UI into every page    | The plugin layer: `worker/src/plugins/<id>/widget.ts` → built bundle, injected for members only, site on the tag   |
| An element picker            | The comments widget's pick mode + `cssPath()`                                                                       |
| Overwrite guard              | The deploy `owner` 409 + `?force=1`                                                                                 |
| Version history              | `deploys` table + `listDeploys()` (unused today; written to back rollback)                                           |

What's missing is three small worker changes (below) and the widget itself.

Precedent: Quick (Brisk's inspiration) has no in-browser editing — its deploy
is a bucket rsync and updates are CLI overwrites. This would be a Brisk-only
capability.

## Decision: a plugin, editing source, not the rendered DOM

**Plugin, not core.** It is a platform battery that sites consume, exactly
what the plugin layer was built for: one directory, one registry line, per-site
opt-in via `brisk.json`, members-only injection for free. The core grows only
the generic affordances listed under "Core changes", each of which the CLI
benefits from too.

**Source editor, not WYSIWYG.** The served DOM contains the injected plugin
scripts plus everything the page's own JS rendered at runtime; serializing it
back to `index.html` would bake a guestbook's rendered posts into its source.
The raw-file route returns the pristine object from storage, so a source editor
never has that problem. `contentEditable`/`designMode` is rejected for v1.

Rejected alternatives:

- **A native editor page on the dashboard** — fails the brief (edit where you're
  looking) and grows the core with UI the plugin layer exists to hold.
- **`brisk.hosting.deploy()` in the SDK** — lets pages redeploy sites; that's
  the custom-backend door the philosophy closes.
- **AI-assisted edits** (pick an element, type an instruction, `brisk.ai`
  rewrites the file) — a good v2 on the same save path, not v1.

## Widget UX

Shell follows the comments widget: shadow-DOM host, corner pill, `Shift+E`
hide/restore with the same hotkey guards (ignored in inputs / contenteditable,
and when any modifier besides Shift is held).

- **Panel** — collapsible right overlay. File list (text files editable;
  binaries listed with size, not editable). The page's own source file opens by
  default (see `data-brisk-page` below).
- **Editor** — a plain `<textarea>`: monospace, Tab inserts two spaces,
  `⌘/Ctrl+S` saves. No CodeMirror — the widget bundle stays dependency-free
  like the rest of the platform. Syntax highlighting is a later overlay if ever.
- **Jump to source** — the comments picker reused: click an element, the panel
  scrolls the textarea to the first match of its `outerHTML` (then its opening
  tag) in the current file. Best-effort; a miss just leaves the cursor where it
  was.
- **New file** — name + empty buffer; included in the next save. Delete and
  rename are v2 (they need a full redeploy or a delete list).
- **Save** — partial redeploy (below) → on success, reload the page. On the
  owner 409: "owned by X — overwrite?" → retry with `force`. On a concurrency
  409: "someone deployed since you opened this — reload to see it", and keep
  the buffer so nothing is lost.
- **Dirty state** — `beforeunload` guard when a buffer differs from what was
  loaded. Unsaved buffers also persist to `localStorage` keyed by site + file +
  the `updatedAt` they were loaded against, so a reload doesn't eat an edit.

## Core changes

Three, each small, each useful beyond this plugin.

### 1. Tell the widget which file the page came from

`serveSite` already resolves `/about` → `about.html`, directory indexes, and the
lone-page case. Surface the resolved candidate: `serveSite` sets an internal
header on its response; `injectWidgets` copies it onto every injected tag as
`data-brisk-page="about.html"` (and strips the header). ~10 lines across
`sites.ts` and `plugins/inject.ts`.

### 2. Partial redeploy

`POST /api/deploy/:name?base=live` (name to settle during implementation): the
form's files are overlaid on the live deploy's files; everything else is copied
forward into the fresh version prefix; then the pointer swaps. Same atomicity
invariant as today — never write into a live prefix. The stored `plugins` set
is preserved unless an `x-brisk-plugins` header says otherwise.

Why it's required, not nice-to-have:

- Without it the browser must re-download and re-upload every file per save.
- **The plugins-reset trap.** A deploy with no `x-brisk-plugins` header resolves
  to registry defaults (`resolveEnabled(plugins, {})` in `app.ts`). An
  `optional` editor plugin saving through the plain deploy route would switch
  itself off on its first save.

Cost: R2 `get`/`put` each count as a Cloudflare subrequest, so copy-forward
spends two per unchanged file.

| Plan         | Subrequests per request |
| ------------ | ----------------------- |
| Workers Free | 50                      |
| Workers Paid | 10,000                  |

The free plan already caps a full deploy near 50 files; copy-forward halves that
for the editor path. Internal sites are a handful of files, so this is a docs
note, not a blocker. Node/S3 can use server-side copy; the Cloudflare
`Storage` adapter streams get→put (R2 has no copy in the Workers binding).

`brisk dev` can later use the same route to push only changed files.

### 3. Optimistic concurrency on deploy

The widget sends the site's `updatedAt` it loaded (`x-brisk-if-updated-at`);
the deploy route 409s with `code: 'stale'` if the row's `updated_at` differs.
An editor makes two teammates changing one site at the same time likely in a
way CLI deploys never did. The CLI ignores it (no header → no check), so
nothing changes for existing callers.

## Requirement level and safety

Ship as **`optional`**. With `DEPLOY_HISTORY=off` a save deletes the previous
version, so a bad edit is unrecoverable unless someone has the source locally.
That is a heavier footgun than a comment pin and argues for per-site opt-in
until rollback exists.

With history on, every save is a version row. A `rollback` action on this
plugin (`brisk plugin editor rollback <site> <version>`) — pointer swap to an
existing retained prefix, no upload — is the natural safety net, and the point
at which `default` becomes reasonable. It is the one action worth declaring in
the plugin's manifest; reads and saves are already covered by `brisk pull` /
`brisk deploy`, so the widget talks to the hosting routes directly.

## Build order

1. Core: `data-brisk-page` plumbing (+ injection test).
2. Core: partial redeploy + plugins preservation (+ tests: copy-forward,
   overlay, stored plugins kept, header still overrides).
3. Core: `x-brisk-if-updated-at` (+ test).
4. Plugin: `worker/src/plugins/editor/` — registry entry, widget (files, editor,
   save, owner/stale handling, dirty guard, hide/restore).
5. Plugin: jump-to-source via the shared picker (extract `cssPath` and pick
   mode from the comments widget into a shared module if it stays clean).
6. Docs: README plugins section, `skills/brisk/references/`, CHANGELOG.
7. Later: `rollback` action; AI-assisted edit; delete/rename.

Rough size: widget 600–800 lines (comments is ~1,200); core ~100 lines plus
tests.

## Open questions (to settle when un-parked)

- Requirement level at launch: `optional` (recommended) or `default`.
- Whether AI-assisted editing is in v1.
- Route shape for the partial redeploy: a query flag on `/api/deploy/:name` vs
  a separate `PATCH /api/sites/:name/files`.
- Whether the comments and editor widgets share one corner pill (two pills on
  every page is clutter) — a shared shell module, or keep them independent.
