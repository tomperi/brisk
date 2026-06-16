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

describe('import boundary', () => {
  it('core and cloudflare files never import node: builtins or platform/node', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file.includes(`${join('platform', 'node')}`) || file.endsWith('index.node.ts')) continue;
      const text = readFileSync(file, 'utf8');
      if (/from\s+['"]node:/.test(text) || /from\s+['"].*platform\/node/.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
