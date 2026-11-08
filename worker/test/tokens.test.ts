import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { sign } from 'hono/jwt';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { buildCloudflarePlatform } from '../src/platform/cloudflare/platform';
import { tokenNeed } from '../src/tokens';

const app = createApp((c) => buildCloudflarePlatform(c.env, c.executionCtx));

const googleEnv = {
  ...env,
  AUTH: 'google' as const,
  VISIBILITY: 'private' as const,
  SESSION_SECRET: 'test-secret',
  DEPLOY_TOKEN: 'ci-token',
};

async function fetchUrl(url: string, init?: RequestInit, authEnv: typeof env = googleEnv) {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(url, init), authEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const fetchAs = (path: string, init?: RequestInit, authEnv?: typeof env) =>
  fetchUrl(`http://localhost${path}`, init, authEnv);

const bearer = (token: string, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${token}`,
  ...extra,
});

let cli = '';
beforeAll(async () => {
  cli = await sign(
    {
      email: 'tom@yourco.com',
      name: 'Tom',
      kind: 'cli',
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    'test-secret',
  );
});

async function createToken(body: unknown) {
  return fetchAs('/api/tokens', {
    method: 'POST',
    headers: bearer(cli, { 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

async function mint(sites: string[], scopes: string[]) {
  const res = await createToken({ label: `ci ${sites.join(',')}`, sites, scopes });
  expect(res.status).toBe(201);
  return (await res.json()) as { token: { id: string }; secret: string };
}

function deploy(site: string, token: string, html = '<h1>hi</h1>') {
  const form = new FormData();
  form.append('files', new File([html], 'index.html'));
  return fetchAs(`/api/deploy/${site}`, { method: 'POST', headers: bearer(token), body: form });
}

describe('creating site tokens', () => {
  it('needs a personal CLI token, never a session, the DEPLOY_TOKEN, or AUTH=none', async () => {
    const body = JSON.stringify({ label: 'x', sites: ['tok-create'], scopes: ['read'] });
    const session = await sign(
      { email: 'tom@yourco.com', name: 'Tom', exp: Math.floor(Date.now() / 1000) + 3600 },
      'test-secret',
    );
    const viaCookie = await fetchAs('/api/tokens', {
      method: 'POST',
      headers: { cookie: `brisk_session=${session}`, 'content-type': 'application/json' },
      body,
    });
    expect(viaCookie.status).toBe(403);
    expect(await viaCookie.json()).toMatchObject({ code: 'cli-only' });

    const viaDeployToken = await fetchAs('/api/tokens', {
      method: 'POST',
      headers: bearer('ci-token'),
      body,
    });
    expect(viaDeployToken.status).toBe(403);

    const open = await fetchAs('/api/tokens', { method: 'POST', body }, env);
    expect(open.status).toBe(400);

    const created = await createToken(JSON.parse(body));
    expect(created.status).toBe(201);
    const { token, secret } = (await created.json()) as {
      token: Record<string, unknown>;
      secret: string;
    };
    expect(secret).toMatch(/^brisk_[\w-]{43}$/);
    expect(token).toMatchObject({
      label: 'x',
      sites: ['tok-create'],
      scopes: ['read'],
      disabled: false,
      createdBy: 'tom@yourco.com',
      lastUsedAt: null,
    });
  });

  it('validates the label, sites, and scopes', async () => {
    const cases = [
      { label: '', sites: ['a'], scopes: ['read'] },
      { label: 'x', sites: [], scopes: ['read'] },
      { label: 'x', sites: ['Bad Name'], scopes: ['read'] },
      { label: 'x', sites: ['api'], scopes: ['read'] },
      { label: 'x', sites: ['a'], scopes: [] },
      { label: 'x', sites: ['a'], scopes: ['admin'] },
    ];
    for (const body of cases) expect((await createToken(body)).status).toBe(400);
  });

  it('lists tokens without their secret or hash', async () => {
    const { token, secret } = await mint(['tok-list'], ['read']);
    const res = await fetchAs('/api/tokens', { headers: bearer(cli) });
    const text = await res.text();
    expect(text).toContain(token.id);
    expect(text).not.toContain(secret);
    expect(text).not.toContain('"hash"');
  });
});

describe('site token scopes', () => {
  it('splits deploys into write (first) and update (redeploy)', async () => {
    const writeOnly = await mint(['tok-deploy-w'], ['write']);
    expect((await deploy('tok-deploy-w', writeOnly.secret)).status).toBe(200);
    const again = await deploy('tok-deploy-w', writeOnly.secret);
    expect(again.status).toBe(403);
    expect(await again.json()).toMatchObject({ code: 'token-scope' });

    const updateOnly = await mint(['tok-deploy-u'], ['update']);
    expect((await deploy('tok-deploy-u', updateOnly.secret)).status).toBe(403);

    const both = await mint(['tok-deploy-wu'], ['write', 'update']);
    expect((await deploy('tok-deploy-wu', both.secret)).status).toBe(200);
    expect((await deploy('tok-deploy-wu', both.secret)).status).toBe(200);
    const info = await fetchAs('/api/sites/tok-deploy-wu', { headers: bearer('ci-token') });
    expect(await info.json()).toMatchObject({ owner: 'ci tok-deploy-wu' });
  });

  it('only touches the sites it names', async () => {
    const { secret } = await mint(['tok-mine'], ['read', 'write', 'update', 'delete']);
    const other = await deploy('tok-other', secret);
    expect(other.status).toBe(403);
    expect(await other.json()).toMatchObject({ code: 'token-site' });
    expect(
      (await fetchAs('/api/db/notes', { headers: bearer(secret, { 'x-brisk-site': 'tok-other' }) }))
        .status,
    ).toBe(403);
    expect(
      (await fetchAs('/api/sites/tok-other', { method: 'DELETE', headers: bearer(secret) })).status,
    ).toBe(403);
  });

  it('maps db and site routes to read, write, update, delete', async () => {
    const site = 'tok-crud';
    const h = (token: string) =>
      bearer(token, { 'x-brisk-site': site, 'content-type': 'application/json' });
    const all = await mint([site], ['read', 'write', 'update', 'delete']);
    const readOnly = await mint([site], ['read']);
    expect((await deploy(site, all.secret)).status).toBe(200);

    const created = await fetchAs('/api/db/notes', {
      method: 'POST',
      headers: h(all.secret),
      body: JSON.stringify({ text: 'a' }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    expect((await fetchAs('/api/db/notes', { headers: h(readOnly.secret) })).status).toBe(200);
    expect((await fetchAs(`/api/sites/${site}`, { headers: h(readOnly.secret) })).status).toBe(200);
    expect((await fetchAs(`/s/${site}/`, { headers: h(readOnly.secret) })).status).toBe(200);
    expect(
      (await fetchUrl(`http://${site}.localhost/`, { headers: h(readOnly.secret) })).status,
    ).toBe(200);

    const denied = [
      fetchAs('/api/db/notes', { method: 'POST', headers: h(readOnly.secret), body: '{}' }),
      fetchAs(`/api/db/notes/${id}`, { method: 'PATCH', headers: h(readOnly.secret), body: '{}' }),
      fetchAs(`/api/db/notes/${id}`, { method: 'DELETE', headers: h(readOnly.secret) }),
      fetchAs(`/api/sites/${site}`, { method: 'DELETE', headers: h(readOnly.secret) }),
    ];
    for (const res of await Promise.all(denied)) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'token-scope' });
    }

    const patched = await fetchAs(`/api/db/notes/${id}`, {
      method: 'PATCH',
      headers: h(all.secret),
      body: JSON.stringify({ text: 'b' }),
    });
    expect(patched.status).toBe(200);
    expect(
      (await fetchAs(`/api/db/notes/${id}`, { method: 'DELETE', headers: h(all.secret) })).status,
    ).toBe(200);
    expect(
      (await fetchAs(`/api/sites/${site}`, { method: 'DELETE', headers: h(all.secret) })).status,
    ).toBe(200);
  });

  it('cannot reach routes outside its sites: tokens, CLI login, ai, realtime, listings', async () => {
    const { secret } = await mint(['tok-routes'], ['read', 'write', 'update', 'delete']);
    const h = bearer(secret, { 'x-brisk-site': 'tok-routes' });
    const requests = [
      fetchAs('/api/tokens', { headers: h }),
      fetchAs('/api/tokens', { method: 'POST', headers: h, body: '{}' }),
      fetchAs('/auth/cli?port=4444&state=abc', { headers: h }),
      fetchAs('/api/ai/chat', { method: 'POST', headers: h, body: '"hi"' }),
      fetchAs('/api/ws', { headers: { ...h, upgrade: 'websocket' } }),
      fetchAs('/api/sites', { headers: h }),
      fetchAs('/api/plugins', { headers: h }),
      fetchAs('/', { headers: h }),
    ];
    for (const res of await Promise.all(requests)) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'token-route' });
    }
    expect((await fetchAs('/api/me', { headers: h })).status).toBe(200);
  });

  it('classifies the routing path, so an encoded path cannot pass as another route', async () => {
    expect(tokenNeed('POST', '/api/deploy/a', 'home', null)).toEqual({
      site: 'a',
      scope: 'deploy',
    });
    expect(tokenNeed('GET', '/whatever', 'home', 'a')).toEqual({ site: 'a', scope: 'read' });
    expect(tokenNeed('POST', '/whatever', 'home', 'a')).toBeNull();
    expect(tokenNeed('GET', '/api/tokens', 'a', 'a')).toBeNull();

    const { secret } = await mint(['tok-encoded'], ['read']);
    const form = new FormData();
    form.append('files', new File(['x'], 'index.html'));
    const res = await fetchUrl('http://tok-encoded.localhost/%61pi/deploy/tok-encoded', {
      method: 'POST',
      headers: bearer(secret),
      body: form,
    });
    expect(res.status).not.toBe(200);
    expect((await fetchAs('/api/sites/tok-encoded', { headers: bearer('ci-token') })).status).toBe(
      404,
    );
  });
});

describe('site token lifecycle', () => {
  it('disables, enables, and deletes', async () => {
    const { token, secret } = await mint(['tok-life'], ['read']);
    const me = () => fetchAs('/api/me', { headers: bearer(secret) });
    const patch = (disabled: unknown) =>
      fetchAs(`/api/tokens/${token.id}`, {
        method: 'PATCH',
        headers: bearer(cli, { 'content-type': 'application/json' }),
        body: JSON.stringify({ disabled }),
      });

    expect((await me()).status).toBe(200);
    expect((await patch('yes')).status).toBe(400);
    expect(await (await patch(true)).json()).toMatchObject({ disabled: true });
    const off = await me();
    expect(off.status).toBe(401);
    expect(await off.json()).toMatchObject({ error: `site token ${token.id} is disabled` });

    expect(await (await patch(false)).json()).toMatchObject({ disabled: false });
    expect((await me()).status).toBe(200);

    const listed = await fetchAs('/api/tokens', { headers: bearer(cli) });
    const { tokens } = (await listed.json()) as { tokens: { id: string; lastUsedAt: string }[] };
    expect(tokens.find((t) => t.id === token.id)?.lastUsedAt).toBeTruthy();

    const del = () =>
      fetchAs(`/api/tokens/${token.id}`, { method: 'DELETE', headers: bearer(cli) });
    expect((await del()).status).toBe(200);
    expect((await del()).status).toBe(404);
    const gone = await me();
    expect(gone.status).toBe(401);
    expect(await gone.json()).toMatchObject({ error: 'invalid site token' });
  });
});

describe('what a hostile page can do with a viewer session', () => {
  const sessionCookie = async () =>
    `brisk_session=${await sign(
      { email: 'tom@yourco.com', name: 'Tom', exp: Math.floor(Date.now() / 1000) + 3600 },
      'test-secret',
    )}`;

  it('can disable a token but never re-enable one', async () => {
    const { token } = await mint(['tok-revive'], ['read']);
    const patch = async (disabled: boolean) =>
      fetchAs(`/api/tokens/${token.id}`, {
        method: 'PATCH',
        headers: { cookie: await sessionCookie(), 'content-type': 'application/json' },
        body: JSON.stringify({ disabled }),
      });
    expect((await patch(true)).status).toBe(200);
    const revive = await patch(false);
    expect(revive.status).toBe(403);
    expect(await revive.json()).toMatchObject({ code: 'cli-only' });
  });

  it('gets the CLI consent page even when it adds a junk bearer header', async () => {
    const res = await fetchAs('/auth/cli?port=4444&state=abc', {
      headers: { cookie: await sessionCookie(), authorization: 'Bearer junk' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Authorize the Brisk CLI');
  });
});

describe('edge cases', () => {
  it('still accepts a DEPLOY_TOKEN that happens to start with brisk_', async () => {
    const prefixed = { ...googleEnv, DEPLOY_TOKEN: 'brisk_operator-picked-this' };
    const me = await fetchAs(
      '/api/me',
      { headers: bearer('brisk_operator-picked-this') },
      prefixed,
    );
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: 'ci@brisk' });
  });

  it('keeps an uploaded file inside its site path', async () => {
    const res = await fetchAs('/files/a/x/..%2F..%2Fb%2Fid%2Fn.txt', {
      headers: bearer('ci-token'),
    });
    expect(res.status).toBe(404);
  });
});
