import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';

const app = createApp();

/** The deployed test env runs AUTH=none; override per request to test google mode. */
const googleEnv = {
  ...env,
  AUTH: 'google' as const,
  SESSION_SECRET: 'test-secret',
  DEPLOY_TOKEN: 'ci-token',
};

async function fetchAs(authEnv: typeof env, path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`http://localhost${path}`, init), authEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe('auth=google', () => {
  it('401s APIs and redirects browsers when unauthenticated', async () => {
    const api = await fetchAs(googleEnv, '/api/me');
    expect(api.status).toBe(401);

    const browser = await fetchAs(googleEnv, '/', { headers: { accept: 'text/html' } });
    expect(browser.status).toBe(302);
    expect(browser.headers.get('location')).toContain('/auth/login');
  });

  it('accepts the CI deploy token and attributes it as ci@brisk', async () => {
    const res = await fetchAs(googleEnv, '/api/me', {
      headers: { authorization: 'Bearer ci-token' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ email: 'ci@brisk' });
  });

  it('mints a personal token via /auth/cli that authenticates with real identity', async () => {
    const minted = await fetchAs(googleEnv, '/auth/cli?port=4444&state=abc', {
      headers: { authorization: 'Bearer ci-token' },
    });
    expect(minted.status).toBe(302);
    const callback = new URL(minted.headers.get('location')!);
    expect(callback.origin).toBe('http://127.0.0.1:4444');
    expect(callback.searchParams.get('state')).toBe('abc');
    const token = callback.searchParams.get('token')!;
    expect(token).toBeTruthy();

    const me = await fetchAs(googleEnv, '/api/me', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: 'ci@brisk' }); // whoever minted it
  });

  it('rejects garbage bearers and bad callback ports', async () => {
    const bad = await fetchAs(googleEnv, '/api/me', {
      headers: { authorization: 'Bearer nonsense' },
    });
    expect(bad.status).toBe(401);

    const badPort = await fetchAs(googleEnv, '/auth/cli?port=80&state=abc', {
      headers: { authorization: 'Bearer ci-token' },
    });
    expect(badPort.status).toBe(400);
  });
});

describe('auth=none', () => {
  it('tells the CLI no token is needed', async () => {
    const res = await fetchAs(env, '/auth/cli?port=4444&state=xyz');
    expect(res.status).toBe(302);
    const callback = new URL(res.headers.get('location')!);
    expect(callback.searchParams.get('open')).toBe('1');
    expect(callback.searchParams.get('token')).toBeNull();
  });
});
