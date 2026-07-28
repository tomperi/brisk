// Bundles every plugin widget entry (`src/plugins/<id>/widget.ts`) into
// `assets/plugins/<id>/widget.js`, the file the worker injects and serves at
// /_plugins/<id>/widget.js. Globbed, not hardcoded, so a fork adding a widget
// plugin is one directory with no build-script edit — the same "one directory
// lights up everywhere" contract the registry keeps. Built (gitignored) like
// brisk.js and changelog.html; wired into `build`/`build:widgets` and the
// Dockerfile build stage. See worker/package.json.
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url)); // worker/scripts
const pluginsDir = join(here, '..', 'src', 'plugins');

const widgets = readdirSync(pluginsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(pluginsDir, entry.name, 'widget.ts')))
  .map((entry) => entry.name);

await Promise.all(
  widgets.map((id) =>
    build({
      entryPoints: [join(pluginsDir, id, 'widget.ts')],
      outfile: join(here, '..', 'assets', 'plugins', id, 'widget.js'),
      bundle: true,
      format: 'iife',
    }),
  ),
);

console.log(`widgets → assets/plugins/{${widgets.join(',')}}/widget.js (${widgets.length})`);
