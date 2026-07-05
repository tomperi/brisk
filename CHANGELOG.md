# Changelog

All notable changes to Brisk are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Tagged
releases are published to
[GitHub Releases](https://github.com/tomperi/brisk/releases).

## [Unreleased]

### Added

- Deploys record a self-asserted `owner` (from `--username`, else the profile).
  Overwriting a site owned by someone else now needs confirmation — the CLI
  prompts, or pass `--force` / `BRISK_FORCE=1`. A spoofable label and footgun
  guard, never access control: unowned sites and every other action stay open.
- `DEPLOY_HISTORY=on` retains every published deploy as an immutable version
  in a new `deploys` table — version history now, rollback later. Off by
  default: the previous version is deleted after each atomic swap, keeping
  storage bounded.
- A `/changelog` page rendered from this file and linked from the dashboard
  nav; tag pushes now cut their GitHub release notes from the same
  `CHANGELOG.md`.
- OpenGraph image and social meta tags, so shared Brisk links unfurl with a
  preview card.
- A `room` example — a Three.js isometric diorama.

### Changed

- Expanded the self-hosting guide with a how-it-works walkthrough, public
  demo mode, and an architecture diagram.
- Bumped `wrangler` and `esbuild`, with a pinned `undici` override.

### Fixed

- Security hardening: `/auth/cli` browser sessions must confirm through a
  CSRF-guarded consent page before a token is minted, API and dashboard
  responses carry `nosniff` and anti-framing headers, and uploads serve as
  attachments.
- Closed a visitor cache-poisoning hole — static pages resolve the site from
  the host only, never a client header — and an unset `AUTH` on a public host
  now fails closed instead of serving an open backend.
- An open (`AUTH=none`) public instance can no longer ship silently: the
  fail-closed 503 now spells out the secure setup, the worker warns once when
  open on purpose, and `brisk deploy` warns and confirms before pushing to an
  open host (bypass with `--yes` / `BRISK_YES=1`).
- Generated assets (`/brisk.js` and the `/changelog` page) are now built
  during `wrangler deploy`, so they ship with the worker instead of 404ing.
- Dashboard mobile layout: compact site rows, tighter headings, and a header
  that wraps instead of breaking mid-word.

## [0.1.0] - 2026-06-14

### Added

- Folder-to-site deploys on a single Cloudflare Worker, backed by R2, D1, and
  Durable Objects — atomic version swaps, first-come site names, no config
  files.
- The `brisk` CLI: `init`, `deploy`, `dev` (watch and redeploy on every save),
  `list`, `open`, and `pull` to download any site's source. `brisk login`
  stores AWS-style per-instance profiles (`whoami`, `profiles`,
  `profile use`).
- The zero-dependency browser SDK served at `/brisk.js`: `brisk.db`
  (schemaless collections with realtime subscriptions), `brisk.fs` (uploads to
  permanent URLs), `brisk.channel` (realtime messaging and presence),
  `brisk.me` (identity), and `brisk.ai` (LLM calls proxied through the
  server's Anthropic/OpenAI keys).
- Realtime over one Durable Object per site — database change events, channel
  messages, and presence — using WebSocket hibernation so idle rooms cost
  nothing.
- Optional Google OAuth on the apex domain with a session cookie scoped to
  every site subdomain, plus `ALLOWED_EMAILS` / `ALLOWED_EMAIL_DOMAINS`
  allowlists, personal CLI tokens, and a CI deploy token.
- `VISIBILITY=public` demo mode: signed-out visitors get edge-cached,
  view-only access while every `brisk.*` API stays members-only.
- The dashboard at the apex domain — a live list of every site, drag-and-drop
  deploys with a launch flow and confetti, a one-page SDK reference at
  `/docs`, and a self-hosting guide at `/host`.
- `@usebrisk/cli` and `@usebrisk/sdk` published to npm, cut in lockstep by a
  tag-driven release workflow.

[unreleased]: https://github.com/tomperi/brisk/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/tomperi/brisk/releases/tag/v0.1.0
