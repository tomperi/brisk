import fs from 'node:fs';
import { cyan, yellow } from './ui.js';

export const CLI_VERSION: string = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

/** True when `a` is a later x.y.z than `b`; anything unparseable is never newer. */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}

let warned = false;

/** Once per run, on stderr so `--json` output stays clean: the instance is newer than this CLI. */
export function noteServerVersion(server: string | null): void {
  if (warned || !server || !isNewer(server, CLI_VERSION)) return;
  warned = true;
  console.error(
    `${yellow('note:')} this instance runs Brisk ${server}; your CLI is ${CLI_VERSION}. ` +
      `Update for the new features: ${cyan('npm install -g @usebrisk/cli@latest')}`,
  );
}
