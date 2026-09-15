// Renders worker/assets/llms.txt, the one-file, agent-readable copy of
// everything about Brisk, from the sources that already exist: the companion
// skill, the /docs and /host pages, the README's architecture section, and
// CHANGELOG.md. Generated like changelog.html (gitignored, built) so none of
// those becomes a second copy to maintain. Wired into `pnpm build` ahead of
// tsc; see worker/package.json.
//
// The HTML → markdown step is deliberately tiny: docs.html and host.html use a
// fixed handful of tags (h1/h2, p, pre>code, ul/ol>li, table, and inline
// a/code/strong/em), and the script throws on anything else rather than
// silently dropping content.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // worker/scripts
const ROOT = join(here, '..', '..');
const OUT = join(here, '..', 'assets', 'llms.txt');
const REPO = 'https://github.com/tomperi/brisk';
const RAW = 'https://raw.githubusercontent.com/tomperi/brisk/main';

const read = (...path) => readFileSync(join(ROOT, ...path), 'utf8');
const { version } = JSON.parse(read('package.json'));

// ---- markdown helpers -------------------------------------------------------

/** Push every heading down one level, outside code fences, so each source
 *  becomes one H2 section of a file with a single H1. */
function demote(md) {
  let fenced = false;
  return md
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) fenced = !fenced;
      return !fenced && /^#{1,5}\s/.test(line) ? `#${line}` : line;
    })
    .join('\n');
}

/** Drop the YAML frontmatter block a skill file opens with. */
const stripFrontmatter = (md) => md.replace(/^---\n[\s\S]*?\n---\n+/, '');

/** Repo-relative markdown links (`[x](worker/src/platform)`) only resolve on
 *  GitHub, so point them there; anchors, root paths, and full URLs pass through. */
const absolutizeLinks = (md, base) =>
  md.replace(/\]\((?![a-z][a-z0-9+.-]*:|\/|#)([^)]+)\)/g, (_, target) => `](${base}/${target})`);

// ---- html → markdown --------------------------------------------------------

const decode = (s) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

/** Inline content of a p/li/td/heading. Prettier wraps source lines, so
 *  whitespace collapses; tags convert in an order that lets a link wrap code
 *  or bold. Anything left over that looks like a tag is a converter gap. */
function inline(html) {
  const text = html
    .replace(/<a\s[^>]*?href="([^"]*)"[^>]*>([\s\S]*?)<\/a\s*>/g, (_, href, label) => {
      const t = inline(label);
      return href.startsWith('#') && t === href.slice(1) ? t : `[${t}](${href})`;
    })
    .replace(/<code>([\s\S]*?)<\/code>/g, '`$1`')
    .replace(/<strong>([\s\S]*?)<\/strong>/g, '**$1**')
    .replace(/<em>([\s\S]*?)<\/em>/g, '_$1_')
    .replace(/<img\s[^>]*?alt="([^"]*)"[^>]*>/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (/<[a-z]/i.test(text)) throw new Error(`build-llms: unhandled inline markup: ${text}`);
  return decode(text);
}

/** `<h2 id="x"><a href="#x">Title</a></h2>` → `## Title` (the self-link is chrome). */
const heading = (level, html) =>
  `${'#'.repeat(level)} ${inline(html.replace(/<\/?a\b[^>]*>/g, ''))}`;

/** A fenced block. Only the `<code>` wrapper belongs inside a `<pre>`; any
 *  other tag would ship verbatim into a block an agent copies, so it throws. */
function fence(html) {
  const code = html.replace(/<\/?code>/g, '');
  if (/<[a-z]/i.test(code)) {
    throw new Error(`build-llms: unhandled markup in <pre>: ${code.slice(0, 80)}`);
  }
  return '```\n' + decode(code) + '\n```';
}

/** A list item: inline text plus any `<pre>` it embeds, every line after the
 *  first indented under the marker so the whole thing stays one item. */
function item(html, marker) {
  const indent = ' '.repeat(marker.length + 1);
  const parts = html
    .split(/<pre\b[^>]*>([\s\S]*?)<\/pre>/)
    .map((part, i) => (i % 2 ? fence(part) : inline(part)))
    .filter(Boolean);
  return `${marker} ${parts.join('\n\n')}`.replace(/\n(?=.)/g, `\n${indent}`);
}

const items = (html, marker) =>
  [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(([, li], i) => item(li, marker(i))).join('\n');

function table(html) {
  const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(([, tr]) =>
    [...tr.matchAll(/<t[hd]>([\s\S]*?)<\/t[hd]>/g)].map(([, cell]) => inline(cell)),
  );
  const [head, ...body] = rows;
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [line(head), line(head.map(() => '---')), ...body.map(line)].join('\n');
}

/** The article inside <main>, minus the page chrome (nav header, table of
 *  contents, footer), as markdown. Headings come out one level down. */
function pageToMarkdown(html) {
  const main = html.slice(html.indexOf('<main'), html.lastIndexOf('</main>'));
  const article = main
    .replace(/<header>[\s\S]*?<\/header>/, '')
    .replace(/<ul class="toc">[\s\S]*?<\/ul>/, '')
    .replace(/<footer>[\s\S]*?<\/footer>/, '')
    .replace(/^<main[^>]*>/, '');
  const blocks = [];
  const block =
    /<(h1|h2|p|pre|ul|ol|table)\b[^>]*>([\s\S]*?)<\/\1>|<img\s[^>]*?alt="([^"]*)"[^>]*?src="([^"]*)"[^>]*>|<img\s[^>]*?src="([^"]*)"[^>]*?alt="([^"]*)"[^>]*>/g;
  let last = 0;
  for (const m of article.matchAll(block)) {
    const between = article.slice(last, m.index).trim();
    if (between) throw new Error(`build-llms: unhandled block markup: ${between.slice(0, 80)}`);
    last = m.index + m[0].length;
    const [, tag, body, alt1, src1, src2, alt2] = m;
    if (!tag) blocks.push(`![${alt1 ?? alt2}](${src1 ?? src2})`);
    else if (tag === 'h1') blocks.push(heading(2, body));
    else if (tag === 'h2') blocks.push(heading(3, body));
    else if (tag === 'p') blocks.push(inline(body));
    else if (tag === 'pre') blocks.push(fence(body));
    else if (tag === 'ul') blocks.push(items(body, () => '-'));
    else if (tag === 'ol') blocks.push(items(body, (i) => `${i + 1}.`));
    else if (tag === 'table') blocks.push(table(body));
  }
  const tail = article.slice(last).trim();
  if (tail) throw new Error(`build-llms: unhandled block markup: ${tail.slice(0, 80)}`);
  return blocks.join('\n\n');
}

// ---- sources ----------------------------------------------------------------

/** One `## Heading` section of a markdown file, up to the next `## `, minus
 *  images (the hosting page already carries the architecture diagram). */
function section(md, title) {
  const start = md.indexOf(`\n## ${title}\n`);
  if (start < 0) throw new Error(`build-llms: README has no "## ${title}" section`);
  const rest = md.slice(start + 1);
  const end = rest.indexOf('\n## ', 1);
  return (end < 0 ? rest : rest.slice(0, end)).replace(/^!\[[^\]]*\]\([^)]*\)\n+/gm, '');
}

const header = `# Brisk

> Drop a folder, get a site. Brisk is an open-source internal hosting platform: deploy a folder of static files and get a live URL in about a second, plus six zero-config browser APIs — database, identity, AI, file storage, realtime channels, and the hosting itself — from one script tag.

Brisk is for internal use behind a login. Every site is visible and writable by every authenticated teammate; there are no permissions, no site owners, no custom backends, no build steps, no cron jobs, and no seventh primitive. Those constraints are the product. It runs on Cloudflare (one Worker + R2 + D1 + Durable Objects) or self-hosted on any Node box (SQLite plus a disk or an S3 bucket) from the same code.

This file is generated at build time for Brisk ${version} from the repository and the pages of the instance serving it, so it matches what is running here. Root-relative links (\`/docs\`) resolve on this instance.

## Pages on this instance

- [Dashboard](/): every site on the instance; signed-in members can drag a folder onto it to deploy
- [Docs](/docs): the one-page SDK reference (mirrored below)
- [Hosting](/host): running your own instance (mirrored below)
- [Changelog](/changelog): every release (mirrored below)
- [brisk.js](/brisk.js): the browser SDK, served on every site
- [Plugins](/api/plugins): JSON list of the plugins installed here; \`/api/plugins/<id>\` is a plugin's manifest (a signed-in member's call wherever the instance has a login)

## Elsewhere

- [Source](${REPO}): README, architecture, worker internals
- [@usebrisk/cli on npm](https://www.npmjs.com/package/@usebrisk/cli): the \`brisk\` command
- [Realtime wire protocol](${REPO}/blob/main/docs/realtime-protocol.md): what \`brisk.js\` and the worker say to each other
- [The Brisk skill](${REPO}/tree/main/skills/brisk): for Claude Code and other coding agents — install instructions next

## For coding agents: install the Brisk skill

The repository ships a companion skill, \`skills/brisk/\`, that teaches a coding agent the lifecycle around Brisk — target an instance, \`brisk init\`, build with the SDK, \`brisk deploy\`, verify, iterate, act on teammates' comments — and the product constraints that keep a site a Brisk site. It is self-contained: two markdown files that link only to the public repository and \`brisk --help\`.

**Claude Code** discovers skills in \`~/.claude/skills/\` (or a project's \`.claude/skills/\`) from the frontmatter in \`SKILL.md\`. Install it without cloning:

\`\`\`sh
mkdir -p ~/.claude/skills/brisk/references
curl -fsSL ${RAW}/skills/brisk/SKILL.md -o ~/.claude/skills/brisk/SKILL.md
curl -fsSL ${RAW}/skills/brisk/references/sdk.md -o ~/.claude/skills/brisk/references/sdk.md
\`\`\`

From a checkout, \`cp -r skills/brisk ~/.claude/skills/brisk\` does the same.

**Codex and other agents** do not read the frontmatter, so point them at the file directly: reference \`SKILL.md\` from the project's \`AGENTS.md\` ("For Brisk work, follow \`./brisk/SKILL.md\`"), or drop it where the agent already reads project docs. Same content, no second copy to maintain.

Then install the CLI (\`npm install -g @usebrisk/cli\`) and run \`brisk login <this host>\` once. \`brisk init\` also drops an \`AGENTS.md\` with the per-site SDK reference into every folder it scaffolds.

The skill follows, then the SDK cheat-sheet it loads on demand, then the pages of this instance.
`;

const skill = demote(stripFrontmatter(read('skills', 'brisk', 'SKILL.md'))).replace(
  '](references/sdk.md)',
  '](#brisk-sdk-cheat-sheet)',
);
const cheatSheet = demote(read('skills', 'brisk', 'references', 'sdk.md'));
const docs = pageToMarkdown(read('worker', 'assets', 'docs.html'));
const host = pageToMarkdown(read('worker', 'assets', 'host.html'));
const architecture = absolutizeLinks(
  section(read('README.md'), 'Architecture'),
  `${REPO}/blob/main`,
);
const changelog = demote(read('CHANGELOG.md'));

const out = [header, skill, cheatSheet, docs, host, architecture, changelog]
  .map((part) => part.trim())
  .join('\n\n---\n\n');

writeFileSync(OUT, out + '\n');
console.log(`llms.txt → worker/assets/llms.txt (${(out.length / 1024).toFixed(0)} KB)`);
