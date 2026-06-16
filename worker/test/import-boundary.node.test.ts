import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// NOTE: this test reads source files; it does not import them, so it is
// runtime-agnostic. It runs in the node project (named *.node.test.ts) because
// the workers pool doesn't implement node:fs's readdirSync at collection time.

const SRC = join(__dirname, '..', 'src');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

// Node-only npm deps: must appear only in platform/node + index.node.ts, or
// they get pulled into (and bloat/break) the Cloudflare workerd bundle. Add new
// Node-only packages here. Escaped for use inside a RegExp alternation.
const NODE_ONLY = ['@hono/node-server', 'ws', 'aws4fetch'];
const forbidden = `(node:|${NODE_ONLY.map((p) => p.replace(/[/.]/g, '\\$&')).join('|')})`;
// Matches static `from`, dynamic `import()`/`require()`, and side-effect imports
// (`import 'node:fs'`), so a regression can't slip past the lint by changing form.
const NODE_IMPORT = new RegExp(
  `(?:from|import\\(|require\\()\\s*['"]${forbidden}|import\\s+['"]${forbidden}`,
);
const PLATFORM_NODE = /(?:from|import\(|require\()\s*['"][^'"]*platform\/node/;

describe('import boundary', () => {
  it('core and cloudflare files never import node: builtins, Node-only deps, or platform/node', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file.includes(`${join('platform', 'node')}`) || file.endsWith('index.node.ts')) continue;
      const text = readFileSync(file, 'utf8');
      if (NODE_IMPORT.test(text) || PLATFORM_NODE.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
