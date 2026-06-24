#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { argv, stdout } from 'node:process';
import { generate, nextSteps } from './generate.js';
import { ask } from './prompts.js';

async function main(): Promise<void> {
  const force = argv.includes('--force');
  stdout.write('\ncreate-brisk — scaffold a Brisk deployment\n');
  const answers = await ask();

  let wrote = 0;
  for (const file of generate(answers)) {
    if (existsSync(file.path) && !force) {
      stdout.write(`  • skip ${file.path} (exists — pass --force to overwrite)\n`);
      continue;
    }
    writeFileSync(file.path, file.content);
    stdout.write(`  • wrote ${file.path}\n`);
    wrote++;
  }
  if (wrote === 0) {
    throw new Error('scaffolding wrote no files (all targets already exist — pass --force)');
  }

  stdout.write('\nNext steps:\n');
  for (const step of nextSteps(answers)) stdout.write(`${step}\n`);
  stdout.write('\n');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
