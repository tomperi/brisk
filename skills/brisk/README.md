# Brisk companion skill

Teaches a coding agent how to build and deploy [Brisk](https://github.com/tomperi/brisk)
sites: target an instance → `brisk init` → build with the SDK → `brisk deploy` →
verify → iterate. Self-contained — copy this directory anywhere; it links only to
the public repo and `brisk --help`, never to sibling files.

## Install

**Claude Code** — copy this `brisk/` directory into your skills folder:

```sh
cp -r brisk ~/.claude/skills/brisk
```

It's auto-discovered via the frontmatter in `SKILL.md`; it fires when you ask to
build or deploy a Brisk site.

**Codex** — Codex doesn't read the Claude `SKILL.md` frontmatter, so point your
agent at the file directly: reference `SKILL.md` from your project's `AGENTS.md`
(e.g. "For Brisk work, follow `./brisk/SKILL.md`"), or drop `SKILL.md` where
Codex already reads project docs. Same content, no second copy to maintain.

## Contents

- `SKILL.md` — the lifecycle (source of truth).
- `references/sdk.md` — compact SDK cheat-sheet, loaded on demand.

## Keeping it in sync

`references/sdk.md` restates the basic SDK surface. When the Brisk SDK changes
(`sdk/src/brisk.ts` in the [repo](https://github.com/tomperi/brisk)), update the
cheat-sheet alongside the other agent-facing copies (`cli/src/templates.ts`,
`worker/assets/docs.html`).
