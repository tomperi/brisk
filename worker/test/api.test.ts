import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { siteFromHost } from '../src/app';
import { isValidSiteName } from '../src/sites';

const HOST = 'http://localhost';

function deployForm(files: Record<string, string>): FormData {
  const form = new FormData();
  for (const [path, content] of Object.entries(files)) {
    form.append('files', new File([content], path, { type: 'text/html' }));
  }
  return form;
}

describe('site name rules', () => {
  it('accepts plain dns labels and rejects everything else', () => {
    expect(isValidSiteName('my-site')).toBe(true);
    expect(isValidSiteName('a1')).toBe(true);
    expect(isValidSiteName('-nope')).toBe(false);
    expect(isValidSiteName('No.Caps')).toBe(false);
    expect(isValidSiteName('api')).toBe(false); // reserved
  });
});

describe('host routing', () => {
  it('maps subdomains to sites and the bare host to none', () => {
    expect(siteFromHost('foo.brisk.example.com', 'brisk.example.com')).toBe('foo');
    expect(siteFromHost('brisk.example.com', 'brisk.example.com')).toBeNull();
    expect(siteFromHost('a.b.brisk.example.com', 'brisk.example.com')).toBeNull();
    expect(siteFromHost('foo.localhost:8787', '')).toBe('foo');
    expect(siteFromHost('localhost:8787', '')).toBeNull();
  });
});

describe('identity', () => {
  it('returns the dev user when auth is off', async () => {
    const res = await SELF.fetch(`${HOST}/api/me`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: 'dev@localhost', name: 'Dev' });
  });
});

describe('deploy and serve', () => {
  it('deploys a folder and serves it in subdomain and path mode', async () => {
    const res = await SELF.fetch(`${HOST}/api/deploy/greet`, {
      method: 'POST',
      body: deployForm({ 'index.html': '<h1>hi</h1>', 'about.html': '<h1>about</h1>' }),
    });
    expect(res.status).toBe(200);
    const info = await res.json<{ name: string; files: number }>();
    expect(info).toMatchObject({ name: 'greet', files: 2 });

    const path = await SELF.fetch(`${HOST}/s/greet/`);
    expect(await path.text()).toBe('<h1>hi</h1>');

    const subdomain = await SELF.fetch('http://greet.localhost/');
    expect(await subdomain.text()).toBe('<h1>hi</h1>');

    // extensionless resolution
    const about = await SELF.fetch(`${HOST}/s/greet/about`);
    expect(await about.text()).toBe('<h1>about</h1>');
  });

  it('atomically replaces the previous deploy', async () => {
    await SELF.fetch(`${HOST}/api/deploy/swap`, {
      method: 'POST',
      body: deployForm({ 'index.html': 'v1', 'old.txt': 'stale' }),
    });
    await SELF.fetch(`${HOST}/api/deploy/swap`, {
      method: 'POST',
      body: deployForm({ 'index.html': 'v2' }),
    });
    expect(await (await SELF.fetch(`${HOST}/s/swap/`)).text()).toBe('v2');
    expect((await SELF.fetch(`${HOST}/s/swap/old.txt`)).status).toBe(404);
  });

  it('rejects reserved and malformed names', async () => {
    for (const name of ['api', 'Bad.Name']) {
      const res = await SELF.fetch(`${HOST}/api/deploy/${name}`, {
        method: 'POST',
        body: deployForm({ 'index.html': 'x' }),
      });
      expect(res.status).toBe(400);
    }
  });

  it('lists, exposes raw files, and deletes sites', async () => {
    await SELF.fetch(`${HOST}/api/deploy/temp`, {
      method: 'POST',
      body: deployForm({ 'index.html': 'temp' }),
    });

    const list = await (await SELF.fetch(`${HOST}/api/sites`)).json<{ sites: { name: string }[] }>();
    expect(list.sites.map((s) => s.name)).toContain('temp');

    const raw = await SELF.fetch(`${HOST}/api/sites/temp/raw/index.html`);
    expect(await raw.text()).toBe('temp');

    await SELF.fetch(`${HOST}/api/sites/temp`, { method: 'DELETE' });
    expect((await SELF.fetch(`${HOST}/s/temp/`)).status).toBe(404);
  });
});

describe('database', () => {
  const headers = { 'content-type': 'application/json', 'x-brisk-site': 'db-test' };

  it('does full crud, namespaced per site', async () => {
    const created = await (
      await SELF.fetch(`${HOST}/api/db/notes`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: 'first', done: false }),
      })
    ).json<{ id: string; text: string }>();
    expect(created.text).toBe('first');

    const updated = await (
      await SELF.fetch(`${HOST}/api/db/notes/${created.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ done: true }),
      })
    ).json<{ done: boolean; text: string }>();
    expect(updated).toMatchObject({ text: 'first', done: true });

    const listed = await (
      await SELF.fetch(`${HOST}/api/db/notes`, { headers })
    ).json<{ docs: { id: string }[] }>();
    expect(listed.docs).toHaveLength(1);

    // a different site sees nothing
    const other = await (
      await SELF.fetch(`${HOST}/api/db/notes`, { headers: { 'x-brisk-site': 'someone-else' } })
    ).json<{ docs: unknown[] }>();
    expect(other.docs).toHaveLength(0);

    const del = await SELF.fetch(`${HOST}/api/db/notes/${created.id}`, { method: 'DELETE', headers });
    expect((await del.json<{ ok: boolean }>()).ok).toBe(true);
  });

  it('404s on missing docs', async () => {
    const res = await SELF.fetch(`${HOST}/api/db/notes/nope`, { headers });
    expect(res.status).toBe(404);
  });
});

describe('file uploads', () => {
  it('stores and serves uploads', async () => {
    const form = new FormData();
    form.append('files', new File(['png-bytes'], 'pic.png', { type: 'image/png' }));
    const res = await SELF.fetch(`${HOST}/api/fs/upload`, {
      method: 'POST',
      headers: { 'x-brisk-site': 'uploads-test' },
      body: form,
    });
    const { files } = await res.json<{ files: { url: string; name: string }[] }>();
    expect(files[0]!.name).toBe('pic.png');

    const served = await SELF.fetch(`${HOST}${files[0]!.url}`);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe('png-bytes');
  });
});

describe('ai', () => {
  it('explains itself when no provider is configured', async () => {
    const res = await SELF.fetch(`${HOST}/api/ai/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(501);
  });
});
