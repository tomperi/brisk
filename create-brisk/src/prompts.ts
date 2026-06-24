import { createInterface as createPromisesInterface } from 'node:readline/promises';
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import {
  DEFAULT_IMAGE,
  type Answers,
  type AuthMode,
  type StorageKind,
  type Target,
} from './answers.js';

/**
 * A single source of prompt answers. The TTY path reads one line at a time
 * interactively; the non-TTY path reads all of stdin up front and replays it.
 *
 * readline/promises' question() drops every buffered line but the first when
 * stdin hits EOF on a fast pipe (Node 20–24), so sequential question() calls
 * silently hang on `printf … | create-brisk`. Buffering the whole stream first
 * keeps the advertised non-interactive / CI usage working.
 */
interface Reader {
  question(prompt: string): Promise<string>;
  close(): void;
}

function ttyReader(): Reader {
  const rl = createPromisesInterface({ input: stdin, output: stdout });
  return {
    question: (prompt) => rl.question(prompt),
    close: () => rl.close(),
  };
}

async function bufferedReader(): Promise<Reader> {
  const lines: string[] = await new Promise((resolve) => {
    const collected: string[] = [];
    const rl = createInterface({ input: stdin });
    rl.on('line', (l) => collected.push(l));
    rl.on('close', () => resolve(collected));
  });
  let i = 0;
  return {
    question: (prompt) => {
      stdout.write(prompt);
      const line = lines[i++] ?? '';
      stdout.write(`${line}\n`);
      return Promise.resolve(line);
    },
    close: () => {},
  };
}

async function choose<T extends string>(
  rl: Reader,
  label: string,
  options: { value: T; hint: string }[],
  def: T,
): Promise<T> {
  stdout.write(`\n${label}\n`);
  options.forEach((o, i) => stdout.write(`  ${i + 1}) ${o.value} — ${o.hint}\n`));
  const ans = (await rl.question(`> [${def}] `)).trim();
  if (!ans) return def;
  const byNum = options[Number(ans) - 1];
  if (byNum) return byNum.value;
  const byVal = options.find((o) => o.value === ans);
  return byVal ? byVal.value : def;
}

export async function ask(): Promise<Answers> {
  const rl = stdin.isTTY ? ttyReader() : await bufferedReader();
  try {
    const target = await choose<Target>(
      rl,
      'Where will Brisk run?',
      [
        { value: 'compose', hint: 'Docker / a single VM' },
        { value: 'kubernetes', hint: 'EKS or any K8s cluster (Helm)' },
        { value: 'cloudflare', hint: 'Cloudflare Workers' },
      ],
      'compose',
    );

    const auth = await choose<AuthMode>(
      rl,
      'Authentication?',
      [
        { value: 'google', hint: 'Google OAuth (recommended)' },
        { value: 'none', hint: 'open backend — trusted networks only' },
      ],
      'google',
    );

    const baseHost = (
      await rl.question('\nBase host for sites (blank = path-mode /s/<site>/)\n> ')
    ).trim();

    let storage: StorageKind = 'fs';
    let s3;
    if (target !== 'cloudflare') {
      storage = await choose<StorageKind>(
        rl,
        'Storage backend?',
        [
          { value: 'fs', hint: 'filesystem on a volume (leanest)' },
          { value: 's3', hint: 'S3-compatible (AWS S3 / MinIO)' },
        ],
        'fs',
      );
      if (storage === 's3') {
        const endpoint =
          (await rl.question('S3 endpoint [http://minio:9000]\n> ')).trim() || 'http://minio:9000';
        const bucket = (await rl.question('S3 bucket [brisk]\n> ')).trim() || 'brisk';
        const region = (await rl.question('S3 region [us-east-1]\n> ')).trim() || 'us-east-1';
        s3 = { endpoint, bucket, region };
      }
    }

    return { target, auth, baseHost, storage, s3, image: DEFAULT_IMAGE };
  } finally {
    rl.close();
  }
}
