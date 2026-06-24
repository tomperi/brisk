# Phase 5: `create-brisk` Install Wizard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `create-brisk` package (`npm create brisk@latest`) that asks a handful of questions and scaffolds the **deployment glue + config** for the chosen target — Docker Compose, Kubernetes (Helm values), or Cloudflare — against the shared image/chart, never a forked source tree.

**Architecture:** A new zero-runtime-dep package mirroring `cli/` (ESM/NodeNext, `.js` import suffixes, `tsc`→`dist`). The wizard is split into a **pure** `generate(answers) → GeneratedFile[]` + `nextSteps(answers) → string[]` (unit-tested), and a thin `node:readline/promises` prompt layer + an `index.ts` that writes the files (never clobbering existing ones) and prints next steps.

**Tech Stack:** TypeScript (NodeNext), Node ≥20 (`node:readline/promises`, `node:fs`), vitest for the pure-logic tests. Zero runtime dependencies.

**Prerequisites:** Phase 4 complete — the artifacts the wizard templates exist and are stable: `deploy/docker-compose.yml`, `deploy/helm/brisk/values.yaml` (keys: `image.repository/tag`, `config.baseHost/auth/visibility/storage/sqlitePath/fsRoot`, `s3.endpoint/bucket/region`, `secrets.*`, `existingSecret`, `ingress.enabled/host/wildcard/className/tls`, `persistence.*`, `replicaCount`, `healthcheck.path`), and the Node env var names (`STORAGE`, `FS_ROOT`, `SQLITE_PATH`, `S3_*`, `BASE_HOST`, `AUTH`, `VISIBILITY`, …). The published image is `ghcr.io/usebrisk/brisk`.

---

## Scope decisions

- **Generates config, not code.** Compose → a self-contained `docker-compose.yml` (image-based, no build context) + `.env`. Kubernetes → a `brisk-values.yaml` overrides file (+ printed `helm install`). Cloudflare → `.dev.vars` + a `BRISK-CLOUDFLARE.md` checklist. This is the "(A) shared image, generated glue" decision from the design — no source fork.
- **Secrets are never inlined.** Generated files carry **placeholders/empty values**; `nextSteps` tells the user to fill `.env` or pass `--set secrets.*`/`existingSecret`. The wizard never prompts for secret *values*.
- **Only shipped backends are offered.** Storage: S3 or filesystem. Database (SQLite-only today) and realtime scale (single-replica today) are **not** prompted — Postgres/Redis are Phase 6; the wizard notes single-replica for K8s.
- **Never clobber.** `index.ts` skips (with a warning) any output file that already exists unless `--force`.
- **Lean & dependency-free at runtime**, mirroring `cli/`/`sdk/`. `vitest` is a dev-only dep for the pure-logic tests.

---

## File structure

| File | Responsibility | Action |
| --- | --- | --- |
| `pnpm-workspace.yaml` | add `create-brisk` to the workspace | Modify |
| `create-brisk/package.json` | package + `bin: { "create-brisk": "dist/index.js" }` | Create |
| `create-brisk/tsconfig.json` | extends `../tsconfig.base.json` | Create |
| `create-brisk/src/answers.ts` | `Answers`/`GeneratedFile` types + defaults | Create |
| `create-brisk/src/generate.ts` | pure `generate()` + `nextSteps()` | Create |
| `create-brisk/src/prompts.ts` | `node:readline/promises` Q&A → `Answers` | Create |
| `create-brisk/src/index.ts` | orchestrate: prompt → generate → write → print | Create |
| `create-brisk/test/generate.test.ts` | unit tests for `generate`/`nextSteps` | Create |
| `create-brisk/vitest.config.ts` | node-env vitest | Create |
| `README.md` | mention `npm create brisk@latest` | Modify |

---

## Task 1: Package scaffold

**Files:** `pnpm-workspace.yaml`, `create-brisk/package.json`, `create-brisk/tsconfig.json`, `create-brisk/vitest.config.ts`

- [ ] **Step 1: Add to the workspace**

In `pnpm-workspace.yaml`, add `create-brisk`:

```yaml
packages:
  - worker
  - sdk
  - cli
  - create-brisk
```

- [ ] **Step 2: `create-brisk/package.json`** (mirrors `cli/`; package name `create-brisk` so `npm create brisk` resolves)

```json
{
  "name": "create-brisk",
  "version": "0.1.0",
  "description": "Scaffold a Brisk self-host deployment (Docker, Kubernetes, or Cloudflare).",
  "engines": { "node": ">=20.12" },
  "license": "MIT",
  "type": "module",
  "homepage": "https://github.com/tomperi/brisk/tree/main/create-brisk",
  "repository": { "type": "git", "url": "git+https://github.com/tomperi/brisk.git", "directory": "create-brisk" },
  "bugs": "https://github.com/tomperi/brisk/issues",
  "keywords": ["brisk", "create", "scaffold", "kubernetes", "docker"],
  "publishConfig": { "access": "public" },
  "bin": { "create-brisk": "dist/index.js" },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 3: `create-brisk/tsconfig.json`** (mirrors `cli/tsconfig.json`)

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src"]
}
```

> Implementer: confirm `../tsconfig.base.json` uses `module`/`moduleResolution` `NodeNext` (it must, since `cli/` uses `.js` suffixes). If `test/` needs to typecheck, leave it out of the build `include` (tests run via vitest, which transpiles independently).

- [ ] **Step 4: `create-brisk/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
```

- [ ] **Step 5: Install + commit**

Run: `pnpm install` (`run_in_background: true`).

```bash
git add pnpm-workspace.yaml create-brisk/package.json create-brisk/tsconfig.json create-brisk/vitest.config.ts pnpm-lock.yaml
git commit -m "chore(create-brisk): scaffold the wizard package"
```

---

## Task 2: Answer types

**Files:** `create-brisk/src/answers.ts`

- [ ] **Step 1: Write `answers.ts`**

```ts
export type Target = 'compose' | 'kubernetes' | 'cloudflare';
export type StorageKind = 's3' | 'fs';
export type AuthMode = 'none' | 'google';

export interface S3Answers {
  endpoint: string;
  bucket: string;
  region: string;
}

export interface Answers {
  target: Target;
  /** Sites hang off this host (foo.<baseHost>); empty = path-mode (/s/foo/). */
  baseHost: string;
  auth: AuthMode;
  /** Node targets only (compose/kubernetes). */
  storage: StorageKind;
  /** Present when storage === 's3'. */
  s3?: S3Answers;
  /** Container image; defaults to the published image. */
  image: string;
}

export const DEFAULT_IMAGE = 'ghcr.io/usebrisk/brisk:latest';

export interface GeneratedFile {
  path: string;
  content: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add create-brisk/src/answers.ts
git commit -m "feat(create-brisk): answer types"
```

---

## Task 3: The pure generator (TDD)

**Files:** `create-brisk/test/generate.test.ts`, `create-brisk/src/generate.ts`

- [ ] **Step 1: Write the failing tests** (`create-brisk/test/generate.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { generate, nextSteps } from '../src/generate';
import type { Answers } from '../src/answers';

const base: Answers = {
  target: 'compose',
  baseHost: 'brisk.example.com',
  auth: 'google',
  storage: 'fs',
  image: 'ghcr.io/usebrisk/brisk:latest',
};
const fileMap = (a: Answers) => Object.fromEntries(generate(a).map((f) => [f.path, f.content]));

describe('compose target', () => {
  it('emits a self-contained docker-compose.yml + .env (fs)', () => {
    const f = fileMap(base);
    expect(f['docker-compose.yml']).toContain('image: ghcr.io/usebrisk/brisk:latest');
    expect(f['docker-compose.yml']).toContain('env_file');
    expect(f['docker-compose.yml']).not.toContain('build:'); // image-based, not source build
    expect(f['docker-compose.yml']).not.toContain('minio'); // fs storage → no minio
    expect(f['.env']).toContain('AUTH=google');
    expect(f['.env']).toContain('BASE_HOST=brisk.example.com');
    expect(f['.env']).toContain('STORAGE=fs');
    expect(f['.env']).toContain('SESSION_SECRET=');       // placeholder present
    expect(f['.env']).toContain('SQLITE_PATH=/data/brisk.sqlite');
  });

  it('adds a minio service and S3 env when storage is s3', () => {
    const f = fileMap({ ...base, storage: 's3', s3: { endpoint: 'http://minio:9000', bucket: 'brisk', region: 'us-east-1' } });
    expect(f['docker-compose.yml']).toContain('minio');
    expect(f['.env']).toContain('STORAGE=s3');
    expect(f['.env']).toContain('S3_ENDPOINT=http://minio:9000');
    expect(f['.env']).toContain('S3_BUCKET=brisk');
    expect(f['.env']).toContain('S3_ACCESS_KEY_ID=');
  });
});

describe('kubernetes target', () => {
  it('emits a Helm values override file with no inlined secrets', () => {
    const f = fileMap({ ...base, target: 'kubernetes' });
    const v = f['brisk-values.yaml'];
    expect(v).toContain('repository: ghcr.io/usebrisk/brisk');
    expect(v).toContain('auth: google');
    expect(v).toContain('baseHost: brisk.example.com');
    expect(v).toContain('storage: fs');
    expect(v).toContain('enabled: true'); // ingress on (baseHost set)
    // secrets must NOT be inlined with values
    expect(v).not.toMatch(/sessionSecret:\s*\S/);
  });

  it('omits the ingress when no baseHost is given', () => {
    const v = fileMap({ ...base, target: 'kubernetes', baseHost: '' })['brisk-values.yaml'];
    expect(v).toMatch(/enabled:\s*false/);
  });
});

describe('cloudflare target', () => {
  it('emits .dev.vars and a secrets checklist', () => {
    const f = fileMap({ ...base, target: 'cloudflare' });
    expect(f['.dev.vars']).toContain('AUTH=google');
    expect(f['BRISK-CLOUDFLARE.md']).toContain('wrangler secret put SESSION_SECRET');
  });
});

describe('nextSteps', () => {
  it('tells compose users to bring the stack up', () => {
    expect(nextSteps(base).join('\n')).toContain('docker compose');
  });
  it('warns when auth is none', () => {
    expect(nextSteps({ ...base, auth: 'none' }).join('\n').toLowerCase()).toContain('trusted');
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `cd create-brisk && pnpm test` (`run_in_background: true`). Expected: FAIL (`generate` not implemented).

- [ ] **Step 3: Write `create-brisk/src/generate.ts`**

```ts
import { DEFAULT_IMAGE, type Answers, type GeneratedFile } from './answers.js';

// --- helpers ---------------------------------------------------------------

/** Shared instance config as KEY=value lines for a .env / .dev.vars file. */
function envLines(a: Answers, opts: { forCloudflare?: boolean } = {}): string[] {
  const lines: string[] = [];
  if (!opts.forCloudflare) lines.push('PORT=8787');
  lines.push(`AUTH=${a.auth}`);
  lines.push(`BASE_HOST=${a.baseHost}`);
  lines.push('VISIBILITY=private');
  if (a.auth === 'google') {
    lines.push('# Fill these in (AUTH=google):');
    lines.push('SESSION_SECRET=');
    lines.push('GOOGLE_CLIENT_ID=');
    lines.push('GOOGLE_CLIENT_SECRET=');
    lines.push('ALLOWED_EMAIL_DOMAINS=');
    lines.push('DEPLOY_TOKEN=');
  }
  lines.push('# Optional AI pass-through:');
  lines.push('ANTHROPIC_API_KEY=');
  if (!opts.forCloudflare) {
    lines.push(`STORAGE=${a.storage}`);
    lines.push('SQLITE_PATH=/data/brisk.sqlite');
    lines.push('FS_ROOT=/data/objects');
    if (a.storage === 's3' && a.s3) {
      lines.push(`S3_ENDPOINT=${a.s3.endpoint}`);
      lines.push(`S3_BUCKET=${a.s3.bucket}`);
      lines.push(`S3_REGION=${a.s3.region}`);
      lines.push('S3_ACCESS_KEY_ID=');
      lines.push('S3_SECRET_ACCESS_KEY=');
    }
  }
  return lines;
}

// --- docker compose --------------------------------------------------------

function composeFiles(a: Answers): GeneratedFile[] {
  const minio =
    a.storage === 's3'
      ? `
  minio:
    image: minio/minio:latest
    command: server /data --console-address ':9001'
    restart: unless-stopped
    ports: ['9000:9000', '9001:9001']
    environment:
      MINIO_ROOT_USER: \${S3_ACCESS_KEY_ID:-minioadmin}
      MINIO_ROOT_PASSWORD: \${S3_SECRET_ACCESS_KEY:-minioadmin}
    volumes: [minio-data:/data]`
      : '';
  const minioVol = a.storage === 's3' ? '\n  minio-data:' : '';
  const compose = `# Generated by create-brisk. Edit .env for configuration.
services:
  brisk:
    image: ${a.image}
    restart: unless-stopped
    env_file: [.env]
    ports: ['\${PORT:-8787}:8787']
    volumes: [brisk-data:/data]${minio}

volumes:
  brisk-data:${minioVol}
`;
  return [
    { path: 'docker-compose.yml', content: compose },
    { path: '.env', content: envLines(a).join('\n') + '\n' },
  ];
}

// --- kubernetes (helm values) ---------------------------------------------

function kubernetesFiles(a: Answers): GeneratedFile[] {
  const [repository, tag] = a.image.split(':');
  const s3Block =
    a.storage === 's3' && a.s3
      ? `
s3:
  endpoint: ${a.s3.endpoint}
  bucket: ${a.s3.bucket}
  region: ${a.s3.region}`
      : '';
  const ingressOn = a.baseHost ? 'true' : 'false';
  const values = `# Generated by create-brisk. helm install brisk <chart> -f brisk-values.yaml
# Secrets are NOT inlined here — pass them with --set secrets.* or set existingSecret.
replicaCount: 1 # in-process realtime; >1 needs the Redis backplane (not yet shipped)

image:
  repository: ${repository}
  tag: ${tag ?? 'latest'}

config:
  baseHost: ${a.baseHost}
  auth: ${a.auth}
  visibility: private
  storage: ${a.storage}${s3Block}

ingress:
  enabled: ${ingressOn}
  host: ${a.baseHost || 'brisk.example.com'}
  wildcard: true
  tls:
    enabled: ${ingressOn}
    secretName: brisk-tls

persistence:
  enabled: true
  size: 8Gi
`;
  return [{ path: 'brisk-values.yaml', content: values }];
}

// --- cloudflare ------------------------------------------------------------

function cloudflareFiles(a: Answers): GeneratedFile[] {
  const devVars = envLines(a, { forCloudflare: true }).join('\n') + '\n';
  const checklist = `# Deploying Brisk to Cloudflare

Local dev vars are in \`.dev.vars\` (used by \`wrangler dev\`).

## Dashboard variables (Workers & Pages → your worker → Settings → Variables)
- BASE_HOST = ${a.baseHost || '(unset → path-mode /s/<site>/)'}
- AUTH = ${a.auth}
- VISIBILITY = private
${a.auth === 'google' ? '- ALLOWED_EMAIL_DOMAINS = your-company.com\n' : ''}
## Secrets (\`wrangler secret put <NAME>\`)
${a.auth === 'google' ? '- wrangler secret put SESSION_SECRET\n- wrangler secret put GOOGLE_CLIENT_ID\n- wrangler secret put GOOGLE_CLIENT_SECRET\n- wrangler secret put DEPLOY_TOKEN   # optional, for CI\n' : '(none required for AUTH=none)\n'}- wrangler secret put ANTHROPIC_API_KEY   # optional, powers brisk.ai

## Resources + deploy
    npx wrangler d1 create brisk        # paste the id into worker/wrangler.jsonc
    npx wrangler r2 bucket create brisk
    npx wrangler d1 migrations apply brisk --remote
    pnpm --filter @usebrisk/sdk build
    npx wrangler deploy
${a.baseHost ? `\n## Wildcard subdomains\nAttach \`${a.baseHost}\` + route \`*.${a.baseHost}/*\` in the dashboard; add a wildcard DNS record and a cert covering \`*.${a.baseHost}\`. See the repo README → Wildcard subdomains.\n` : ''}`;
  return [
    { path: '.dev.vars', content: devVars },
    { path: 'BRISK-CLOUDFLARE.md', content: checklist },
  ];
}

// --- public API ------------------------------------------------------------

export function generate(a: Answers): GeneratedFile[] {
  switch (a.target) {
    case 'compose':
      return composeFiles(a);
    case 'kubernetes':
      return kubernetesFiles(a);
    case 'cloudflare':
      return cloudflareFiles(a);
  }
}

export function nextSteps(a: Answers): string[] {
  const steps: string[] = [];
  if (a.auth === 'none') {
    steps.push('⚠  AUTH=none serves an OPEN backend — only run this on a trusted network.');
  }
  switch (a.target) {
    case 'compose':
      steps.push('Fill in the secrets in .env, then bring the stack up:');
      steps.push('  docker compose up -d');
      steps.push('  open http://localhost:8787');
      break;
    case 'kubernetes':
      steps.push('Install the chart (from a checkout of the brisk repo):');
      steps.push(
        '  helm install brisk ./deploy/helm/brisk -f brisk-values.yaml \\\n' +
          (a.auth === 'google'
            ? '    --set secrets.sessionSecret=$(openssl rand -hex 32) \\\n    --set secrets.googleClientId=… --set secrets.googleClientSecret=…'
            : '    # AUTH=none needs no secrets'),
      );
      if (a.storage === 's3') steps.push('  # set secrets.s3AccessKeyId / s3SecretAccessKey for your bucket');
      break;
    case 'cloudflare':
      steps.push('Follow BRISK-CLOUDFLARE.md: set the dashboard vars + secrets, then `wrangler deploy`.');
      break;
  }
  return steps;
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `cd create-brisk && pnpm test` (`run_in_background: true`). Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add create-brisk/src/generate.ts create-brisk/test/generate.test.ts
git commit -m "feat(create-brisk): pure deployment-config generator + tests"
```

---

## Task 4: Prompts + entry point

**Files:** `create-brisk/src/prompts.ts`, `create-brisk/src/index.ts`

- [ ] **Step 1: Write `prompts.ts`**

```ts
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { DEFAULT_IMAGE, type Answers, type AuthMode, type StorageKind, type Target } from './answers.js';

async function choose<T extends string>(
  rl: ReturnType<typeof createInterface>,
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
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const target = await choose<Target>(rl, 'Where will Brisk run?', [
      { value: 'compose', hint: 'Docker / a single VM' },
      { value: 'kubernetes', hint: 'EKS or any K8s cluster (Helm)' },
      { value: 'cloudflare', hint: 'Cloudflare Workers' },
    ], 'compose');

    const auth = await choose<AuthMode>(rl, 'Authentication?', [
      { value: 'google', hint: 'Google OAuth (recommended)' },
      { value: 'none', hint: 'open backend — trusted networks only' },
    ], 'google');

    const baseHost = (await rl.question('\nBase host for sites (blank = path-mode /s/<site>/)\n> ')).trim();

    let storage: StorageKind = 'fs';
    let s3;
    if (target !== 'cloudflare') {
      storage = await choose<StorageKind>(rl, 'Storage backend?', [
        { value: 'fs', hint: 'filesystem on a volume (leanest)' },
        { value: 's3', hint: 'S3-compatible (AWS S3 / MinIO)' },
      ], 'fs');
      if (storage === 's3') {
        const endpoint = (await rl.question('S3 endpoint [http://minio:9000]\n> ')).trim() || 'http://minio:9000';
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
```

- [ ] **Step 2: Write `index.ts`**

```ts
#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { argv, stdout } from 'node:process';
import { generate, nextSteps } from './generate.js';
import { ask } from './prompts.js';

async function main(): Promise<void> {
  const force = argv.includes('--force');
  stdout.write('\ncreate-brisk — scaffold a Brisk deployment\n');
  const answers = await ask();

  for (const file of generate(answers)) {
    if (existsSync(file.path) && !force) {
      stdout.write(`  • skip ${file.path} (exists — pass --force to overwrite)\n`);
      continue;
    }
    writeFileSync(file.path, file.content);
    stdout.write(`  • wrote ${file.path}\n`);
  }

  stdout.write('\nNext steps:\n');
  for (const step of nextSteps(answers)) stdout.write(`${step}\n`);
  stdout.write('\n');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
```

- [ ] **Step 3: Build + typecheck**

Run: `cd create-brisk && pnpm build && pnpm typecheck` (`run_in_background: true`). Expected: `dist/index.js` (+ others) emitted, typecheck clean. Confirm `dist/index.js` starts with the shebang.

- [ ] **Step 4: Non-interactive smoke (pipe answers)**

Run from a temp dir:
```bash
cd "$(mktemp -d)" && printf '1\n1\nbrisk.example.com\n1\n' | node /Users/tom/repos/token/brisk/.claude/worktrees/humming-wondering-shamir/create-brisk/dist/index.js
ls; echo '--- .env ---'; cat .env; echo '--- compose ---'; cat docker-compose.yml
```
Expected: writes `docker-compose.yml` + `.env` (compose target, google auth, fs storage), prints next steps. (Answers piped: target=1 compose, auth=1 google, baseHost, storage=1 fs.)

- [ ] **Step 5: Commit**

```bash
git add create-brisk/src/prompts.ts create-brisk/src/index.ts
git commit -m "feat(create-brisk): interactive prompts + file-writing entry"
```

---

## Task 5: Docs + verification

**Files:** `README.md`

- [ ] **Step 1: Mention the wizard in `README.md`**

In the self-hosting section, add: `npm create brisk@latest` scaffolds a deployment for Docker, Kubernetes, or Cloudflare (generates Compose/`.env`, Helm values, or `.dev.vars` + checklist). Note it generates config against the published image/chart — it does not fork the source.

- [ ] **Step 2: Full verification**

Run:
- `cd create-brisk && pnpm test && pnpm build && pnpm typecheck` (`run_in_background: true`) — tests pass, builds, typechecks.
- `cd .. && pnpm -r typecheck` (`run_in_background: true`) — the whole workspace still typechecks (no regression in worker/sdk/cli).
- The Task 4 Step 4 non-interactive smoke once more for each target (pipe `2\n…` for kubernetes, `3\n…` for cloudflare) and eyeball the generated `brisk-values.yaml` / `.dev.vars`.
- `pnpm format`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: mention the create-brisk wizard"
```

---

## What Phase 5 leaves for later

- Publishing the image to `ghcr.io` and the Helm chart as an OCI artifact (a CI job) so the wizard's `helm install` can reference a registry instead of a repo checkout.
- **Phase 6 (opt-in):** Redis-backed `Rooms` (unlocks `replicaCount > 1` and a wizard "multi-replica" option), Postgres `Database` (a wizard DB choice).

---

## Self-review

- **Spec coverage:** Implements the design's `create-brisk` wizard — a separate package (keeping the site-author `brisk` CLI tiny) that scaffolds deployment glue against the shared image/chart, per the "(A) shared image, not a forked source tree" decision. Prompts cover target/auth/baseHost/storage; secrets are placeholders only; single-replica + SQLite are the shipped defaults with Postgres/Redis flagged for Phase 6.
- **Placeholder scan:** No TBDs. The `generate()` outputs are concrete and unit-tested; the interactive layer is smoke-tested via piped stdin.
- **Naming consistency:** Generated env names (`AUTH`, `BASE_HOST`, `STORAGE`, `SQLITE_PATH`, `FS_ROOT`, `S3_ENDPOINT`/`S3_BUCKET`/`S3_REGION`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`) match the Node assembly's `configFromEnv`/`storageFromEnv`. Helm values keys (`image.repository/tag`, `config.baseHost/auth/visibility/storage`, `s3.*`, `ingress.enabled/host/wildcard/tls`, `persistence.*`, `replicaCount`) match Phase 4's `deploy/helm/brisk/values.yaml`. The image `ghcr.io/usebrisk/brisk` matches the Dockerfile/Helm/Compose references.
```
