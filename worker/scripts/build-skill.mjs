// Copies the Brisk skill sources into worker/assets so the /skill page can serve
// them raw — for viewing, copying, downloading, or an agent to fetch and install.
// Generated like brisk.js and changelog.html (gitignored, built), so
// skills/brisk/* stays the single source of truth. Wired into the worker build
// and the Dockerfile; see worker/package.json and the root Dockerfile.
import { copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // worker/scripts
const skillDir = join(here, '..', '..', 'skills', 'brisk'); // repo skill
const assets = join(here, '..', 'assets'); // worker/assets

const files = [
  ['SKILL.md', 'skill.md'],
  ['references/sdk.md', 'sdk.md'],
];
for (const [src, out] of files) {
  copyFileSync(join(skillDir, src), join(assets, out));
  console.log(`skill → worker/assets/${out}`);
}
