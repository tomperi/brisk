import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { isAllowedEmail } from '../src/auth';

const app = createApp();

/** The deployed test env runs AUTH=none; override per request to test google mode. */
const googleEnv = {
  ...env,
  AUTH: 'google' as const,
  VISIBILITY: 'private' as const,
  SESSION_SECRET: 'test-secret',
  DEPLOY_TOKEN: 'ci-token',
};

const publicEnv = { ...googleEnv, VISIBILITY: 'public' as const };

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

describe('visibility=public (demo mode)', () => {
  it('lets visitors view sites with edge-cache headers, members see fresh', async () => {
    const form = new FormData();
    form.append('files', new File(['<h1>demo</h1>'], 'index.html'));
    const deployed = await fetchAs(publicEnv, '/api/deploy/showcase', {
      method: 'POST',
      headers: { authorization: 'Bearer ci-token' },
      body: form,
    });
    expect(deployed.status).toBe(200);

    const visitor = await fetchAs(publicEnv, '/s/showcase/');
    expect(visitor.status).toBe(200);
    expect(await visitor.text()).toBe('<h1>demo</h1>');
    expect(visitor.headers.get('cache-control')).toBe('public, max-age=300');

    const member = await fetchAs(publicEnv, '/s/showcase/', {
      headers: { authorization: 'Bearer ci-token' },
    });
    expect(member.headers.get('cache-control')).toBe('no-cache');
  });

  it('lets visitors list sites for the dashboard', async () => {
    const res = await fetchAs(publicEnv, '/api/sites');
    expect(res.status).toBe(200);
  });

  it('401s every dynamic surface for visitors', async () => {
    const blocked = [
      ['/api/me', {}],
      ['/api/db/notes', {}],
      ['/api/db/notes', { method: 'POST', body: '{}' }],
      ['/api/deploy/showcase', { method: 'POST' }],
      ['/api/fs/upload', { method: 'POST' }],
      ['/api/ai/chat', { method: 'POST', body: '{}' }],
      ['/api/ws', {}],
      ['/api/sites/showcase/raw/index.html', {}],
      ['/files/showcase/x/y.png', {}],
      ['/auth/cli?port=4444&state=abc', {}],
      ['/api/sites/showcase', { method: 'DELETE' }],
    ] as const;
    for (const [path, init] of blocked) {
      const res = await fetchAs(publicEnv, path, init as RequestInit);
      expect(res.status, path).toBe(401);
    }
  });
});

describe('the OAuth guest list', () => {
  const gate =
    (ALLOWED_EMAILS: string, ALLOWED_EMAIL_DOMAINS = '') =>
    (email: string) =>
      isAllowedEmail(email, { ALLOWED_EMAILS, ALLOWED_EMAIL_DOMAINS });

  it('admits everyone when both lists are empty', () => {
    expect(gate('')('anyone@anywhere.com')).toBe(true);
  });

  it('limits to exact emails, case-insensitively', () => {
    const allowed = gate('tom@gmail.com, jane@yourco.com');
    expect(allowed('Tom@Gmail.com')).toBe(true);
    expect(allowed('jane@yourco.com')).toBe(true);
    expect(allowed('someone-else@gmail.com')).toBe(false);
  });

  it('either list admits when both are set', () => {
    const allowed = gate('contractor@gmail.com', 'yourco.com');
    expect(allowed('anyone@yourco.com')).toBe(true);
    expect(allowed('contractor@gmail.com')).toBe(true);
    expect(allowed('stranger@gmail.com')).toBe(false);
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
