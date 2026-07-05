// Renders the repo-root CHANGELOG.md into worker/assets/changelog.html, the
// dashboard's /changelog page. Generated like brisk.js (gitignored, built), so
// CHANGELOG.md stays the single source of truth. Wired into `pnpm build` ahead
// of tsc; see worker/package.json.
//
// This is a deliberately tiny Keep a Changelog -> HTML renderer for exactly the
// subset the file uses: `## [version] - date` sections, `### Group` subheadings,
// `- item` bullets with inline `code` and [text](url). No markdown dependency.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // worker/scripts
const SOURCE = join(here, '..', '..', 'CHANGELOG.md'); // repo root
const OUT = join(here, '..', 'assets', 'changelog.html'); // worker/assets

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Inline markdown -> HTML. Runs on already-escaped text, so brackets, parens,
// and backticks survive to be matched here; links first, then code spans.
const inline = (text) =>
  escapeHtml(text)
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_, label, url) => `<a href="${url.replace(/"/g, '&quot;')}">${label}</a>`,
    )
    .replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);

// CHANGELOG.md -> [{ version, date, groups: [{ name, items }] }]. Everything
// else (the H1, intro prose, blank lines, link-reference definitions) is
// ignored — the page renders its own chrome.
function parse(md) {
  const releases = [];
  let release = null;
  let group = null;
  let itemOpen = false; // mid-bullet, so indented wrapped lines fold into it
  for (const line of md.split('\n')) {
    let m;
    if ((m = /^##\s+\[([^\]]+)\](?:\s+-\s+(.+))?\s*$/.exec(line))) {
      release = { version: m[1].trim(), date: (m[2] || '').trim(), groups: [] };
      releases.push(release);
      group = null;
      itemOpen = false;
    } else if ((m = /^###\s+(.+?)\s*$/.exec(line))) {
      group = release ? { name: m[1].trim(), items: [] } : null;
      if (group) release.groups.push(group);
      itemOpen = false;
    } else if ((m = /^[-*]\s+(.+)$/.exec(line))) {
      if (group) group.items.push(m[1].trim());
      itemOpen = Boolean(group);
    } else if (itemOpen && /^\s+\S/.test(line)) {
      group.items[group.items.length - 1] += ' ' + line.trim(); // wrapped bullet
    } else {
      itemOpen = false; // blank line, H1, intro prose, link-ref defs
    }
  }
  return releases;
}

const slug = (version) =>
  version
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

function renderRelease(release) {
  const id = slug(release.version);
  const date = release.date ? ` <span class="date">${escapeHtml(release.date)}</span>` : '';
  const heading = `<h2 id="${id}"><a href="#${id}">${escapeHtml(release.version)}</a>${date}</h2>`;
  const groups = release.groups.filter((g) => g.items.length);
  const body = groups.length
    ? groups
        .map(
          (g) =>
            `        <h3>${escapeHtml(g.name)}</h3>\n        <ul>\n` +
            g.items.map((it) => `          <li>${inline(it)}</li>`).join('\n') +
            `\n        </ul>`,
        )
        .join('\n')
    : `        <p class="empty">Nothing yet.</p>`;
  return `      <section class="release">\n        ${heading}\n${body}\n      </section>`;
}

function page(releases) {
  const sections = releases.map(renderRelease).join('\n\n');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>brisk changelog</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="/app.css" />
    <script src="/brisk.js" defer></script>
    <script src="/header.js" defer></script>
  </head>
  <body>
    <main class="doc changelog">
      <header>
        <a class="wordmark" href="/">brisk<span class="cursor">▮</span></a>
        <nav>
          <a href="/docs">docs</a>
          <a href="/host">hosting</a>
          <a href="/changelog">changelog</a>
          <a href="https://github.com/tomperi/brisk">source</a>
          <a href="/auth/login" id="signin" hidden>sign in</a>
          <span class="whoami" id="whoami" hidden>
            <span class="presence" id="presence" hidden></span><span id="who"></span>
          </span>
        </nav>
      </header>

      <h1>Changelog</h1>
      <p class="lede">
        Every notable change to Brisk, newest first. Generated from
        <a href="https://github.com/tomperi/brisk/blob/main/CHANGELOG.md">CHANGELOG.md</a> — the
        single source of truth — and mirrored to
        <a href="https://github.com/tomperi/brisk/releases">GitHub Releases</a> on every tag.
      </p>

${sections}

      <footer>
        <span>brisk</span>
        <a href="/">home</a>
        <a href="/docs">docs</a>
        <a href="https://github.com/tomperi/brisk/releases">releases</a>
      </footer>
    </main>
  </body>
</html>
`;
}

const releases = parse(readFileSync(SOURCE, 'utf8'));
writeFileSync(OUT, page(releases));
console.log(`changelog → worker/assets/changelog.html (${releases.length} releases)`);
