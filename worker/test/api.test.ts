import { SELF, createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp, siteFromHost, siteUrl } from '../src/app';
import { isValidSiteName, listDeploys } from '../src/sites';

const HOST = 'http://localhost';

function deployForm(files: Record<string, string>): FormData {
  const form = new FormData();
  for (const [path, content] of Object.entries(files)) {
    form.append('files', new File([content], path, { type: 'text/html' }));
  }
  return form;
}

const app = createApp();

/**
 * Deploy through the app with DEPLOY_HISTORY=on so retention is exercised; the
 * default test env leaves it unset (off). The override keeps the same DB/R2
 * bindings, so `listDeploys(env, site)` and `SELF.fetch` still see the rows.
 */
async function deployWithHistory(site: string, files: Record<string, string>): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`${HOST}/api/deploy/${site}`, { method: 'POST', body: deployForm(files) }),
    { ...env, DEPLOY_HISTORY: 'on' as const },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
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

  it('keeps *.localhost working even when BASE_HOST points at production', () => {
    expect(siteFromHost('palette.localhost:8787', 'brisk.example.com')).toBe('palette');
    expect(siteFromHost('localhost:8787', 'brisk.example.com')).toBeNull();
  });
});

describe('site urls', () => {
  const conn = (reqUrl: string, BASE_HOST: string) =>
    siteUrl({ env: { BASE_HOST } as never, req: { url: reqUrl } }, 'foo');

  it('uses subdomain form only when reached via BASE_HOST', () => {
    expect(conn('https://brisk.example.com/api/sites', 'brisk.example.com')).toBe(
      'https://foo.brisk.example.com/',
    );
    expect(conn('https://bar.brisk.example.com/x', 'brisk.example.com')).toBe(
      'https://foo.brisk.example.com/',
    );
  });

  it('falls back to path form on any other host (local dev, workers.dev)', () => {
    expect(conn('http://localhost:8787/api/sites', 'brisk.example.com')).toBe(
      'http://localhost:8787/s/foo/',
    );
    expect(conn('https://brisk.acme.workers.dev/api/sites', 'brisk.example.com')).toBe(
      'https://brisk.acme.workers.dev/s/foo/',
    );
    expect(conn('http://localhost:8787/api/sites', '')).toBe('http://localhost:8787/s/foo/');
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

  it('retains every publish as an immutable version, newest first', async () => {
    // DEPLOY_HISTORY=on: both publishes are kept (this also covers the on-retains knob).
    await deployWithHistory('ver', { 'index.html': 'first' });
    await deployWithHistory('ver', { 'index.html': 'second' });

    const deploys = await listDeploys(env, 'ver');
    expect(deploys).toHaveLength(2);
    expect(deploys.map((d) => d.version)).toEqual([2, 1]);

    // Serving still follows the live pointer, which names the latest publish.
    expect(await (await SELF.fetch(`${HOST}/s/ver/`)).text()).toBe('second');
  });

  it('keeps versions sequential and distinct under concurrent deploys', async () => {
    // Only the retaining (on) path leaves all versions to inspect deterministically.
    await Promise.all(
      Array.from({ length: 3 }, (_, i) => deployWithHistory('race', { 'index.html': `v${i}` })),
    );
    // The UNIQUE(site,version) index plus the retry-on-collision insert must
    // yield contiguous, non-duplicated versions no matter how the writes interleave.
    const deploys = await listDeploys(env, 'race');
    expect(deploys).toHaveLength(3);
    expect(deploys.map((d) => d.version).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it('prunes the superseded version when DEPLOY_HISTORY is off (default)', async () => {
    await SELF.fetch(`${HOST}/api/deploy/bounded`, {
      method: 'POST',
      body: deployForm({ 'index.html': 'first', 'v1.txt': 'only-in-first' }),
    });
    await SELF.fetch(`${HOST}/api/deploy/bounded`, {
      method: 'POST',
      body: deployForm({ 'index.html': 'second' }),
    });

    // The superseded row is deleted synchronously, so history holds only v2.
    const deploys = await listDeploys(env, 'bounded');
    expect(deploys).toHaveLength(1);
    expect(deploys[0]!.version).toBe(2);

    // Serving follows the live pointer, so the first deploy's unique file is gone.
    expect((await SELF.fetch(`${HOST}/s/bounded/v1.txt`)).status).toBe(404);
  });

  it('drops version history on delete so a re-created site restarts at version 1', async () => {
    await SELF.fetch(`${HOST}/api/deploy/reborn`, {
      method: 'POST',
      body: deployForm({ 'index.html': 'first' }),
    });
    const del = await SELF.fetch(`${HOST}/api/sites/reborn`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(await listDeploys(env, 'reborn')).toHaveLength(0);

    await SELF.fetch(`${HOST}/api/deploy/reborn`, {
      method: 'POST',
      body: deployForm({ 'index.html': 'again' }),
    });
    const deploys = await listDeploys(env, 'reborn');
    expect(deploys).toHaveLength(1);
    expect(deploys.map((d) => d.version)).toEqual([1]);
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

  it('rejects a deploy over the 10 MB site cap', async () => {
    const res = await SELF.fetch(`${HOST}/api/deploy/toobig`, {
      method: 'POST',
      body: deployForm({ 'index.html': 'x'.repeat(11 * 1024 * 1024) }),
    });
    expect(res.status).toBe(413);
  });

  it('lists, exposes raw files, and deletes sites', async () => {
    await SELF.fetch(`${HOST}/api/deploy/temp`, {
      method: 'POST',
      body: deployForm({ 'index.html': 'temp' }),
    });

    const list = await (
      await SELF.fetch(`${HOST}/api/sites`)
    ).json<{ sites: { name: string }[] }>();
    expect(list.sites.map((s) => s.name)).toContain('temp');

    const raw = await SELF.fetch(`${HOST}/api/sites/temp/raw/index.html`);
    expect(await raw.text()).toBe('temp');

    const deleted = await SELF.fetch(`${HOST}/api/sites/temp`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect((await SELF.fetch(`${HOST}/s/temp/`)).status).toBe(404);

    const missing = await SELF.fetch(`${HOST}/api/sites/temp`, { method: 'DELETE' });
    expect(missing.status).toBe(404);
  });
});

describe('site ownership', () => {
  const deployAs = (name: string, who: string | undefined, force = false) =>
    SELF.fetch(`${HOST}/api/deploy/${name}${force ? '?force=1' : ''}`, {
      method: 'POST',
      headers: who ? { 'x-brisk-username': who } : {},
      body: deployForm({ 'index.html': `<h1>${name}</h1>` }),
    });

  const ownerOf = async (name: string): Promise<string | null> =>
    (await (await SELF.fetch(`${HOST}/api/sites/${name}`)).json<{ owner: string | null }>()).owner;

  it('records the deployer as owner and guards overwrites by others', async () => {
    // alice claims the site — she becomes its owner.
    expect((await deployAs('own', 'alice')).status).toBe(200);
    expect(await ownerOf('own')).toBe('alice');

    // alice redeploys her own site: silent, no confirmation.
    expect((await deployAs('own', 'alice')).status).toBe(200);

    // bob can't overwrite without forcing.
    const blocked = await deployAs('own', 'bob');
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ code: 'owned', owner: 'alice' });
    expect(await ownerOf('own')).toBe('alice'); // untouched

    // bob forces it through; owner is set-once, so it stays alice.
    expect((await deployAs('own', 'bob', true)).status).toBe(200);
    expect(await ownerOf('own')).toBe('alice');
  });

  it('never blocks a deploy over an unowned (NULL-owner) site', async () => {
    // A site from before ownership existed: owner column is NULL.
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO sites (name, active_deploy, files, bytes, created_at, updated_at, updated_by, owner)
       VALUES ('legacy', 'seed', 1, 1, ?, ?, 'old', NULL)`,
    )
      .bind(now, now)
      .run();

    // Anyone may deploy over it, and a plain update never auto-claims it.
    expect((await deployAs('legacy', 'bob')).status).toBe(200);
    expect(await ownerOf('legacy')).toBeNull();
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

    const del = await SELF.fetch(`${HOST}/api/db/notes/${created.id}`, {
      method: 'DELETE',
      headers,
    });
    expect((await del.json<{ ok: boolean }>()).ok).toBe(true);
  });

  it('404s on missing docs', async () => {
    const res = await SELF.fetch(`${HOST}/api/db/notes/nope`, { headers });
    expect(res.status).toBe(404);
  });

  it('ignores attempts to forge id/createdAt and bogus limits', async () => {
    const doc = await (
      await SELF.fetch(`${HOST}/api/db/forgery`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: 'fake', createdAt: '1999-01-01', real: true }),
      })
    ).json<{ id: string; createdAt: string }>();
    expect(doc.id).not.toBe('fake');
    expect(doc.createdAt).not.toBe('1999-01-01');

    // negative limit must not disable the cap (SQLite treats LIMIT -1 as ∞)
    const res = await SELF.fetch(`${HOST}/api/db/forgery?limit=-1`, { headers });
    expect((await res.json<{ docs: unknown[] }>()).docs).toHaveLength(1);
  });

  it('rejects malformed x-brisk-site headers', async () => {
    const res = await SELF.fetch(`${HOST}/api/db/notes`, {
      headers: { 'x-brisk-site': 'home/../sneaky' },
    });
    expect(res.status).toBe(400);
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
