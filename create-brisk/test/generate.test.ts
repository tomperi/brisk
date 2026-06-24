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
    expect(f['.env']).toContain('SESSION_SECRET='); // placeholder present
    expect(f['.env']).toContain('SQLITE_PATH=/data/brisk.sqlite');
  });

  it('adds a minio service and S3 env when storage is s3', () => {
    const f = fileMap({
      ...base,
      storage: 's3',
      s3: { endpoint: 'http://minio:9000', bucket: 'brisk', region: 'us-east-1' },
    });
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
    expect(
      nextSteps({ ...base, auth: 'none' })
        .join('\n')
        .toLowerCase(),
    ).toContain('trusted');
  });
});
