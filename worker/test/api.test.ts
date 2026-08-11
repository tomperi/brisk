import { SELF, createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp, siteFromHost, siteUrl } from '../src/app';
import { isValidSiteName, listDeploys } from '../src/sites';
import { buildCloudflarePlatform } from '../src/platform/cloudflare/platform';

const HOST = 'http://localhost';

/** Members get plugin widget tags injected into every served HTML page (even
 *  body-less fragments, where they're appended). Strip them so the serving
 *  assertions here stay about the deployed content itself. */
const stripWidgets = (html: string) =>
  html.replace(/<script src="\/_plugins\/[^"]*"[^>]*><\/script>/g, '');

function deployForm(files: Record<string, string>): FormData {
  const form = new FormData();
  for (const [path, content] of Object.entries(files)) {
    form.append('files', new File([content], path, { type: 'text/html' }));
  }
  return form;
}

const app = createApp((c) => buildCloudflarePlatform(c.env, c.executionCtx));

/** listDeploys takes a Platform now; wrap the shared test D1 so history reads
 *  hit the same rows the app wrote (the throwaway ctx is only for waitUntil,
 *  which a read never uses). */
const listVersions = (site: string) =>
  listDeploys(buildCloudflarePlatform(env, createExecutionContext()), site);

/**
 * Deploy through the app with DEPLOY_HISTORY=on so retention is exercised; the
 * default test env leaves it unset (off). The override keeps the same DB/R2
 * bindings, so `listVersions(site)` and `SELF.fetch` still see the rows.
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
  const conn = (reqUrl: string, BASE_HOST: string, headers: Record<string, string> = {}) =>
    siteUrl(
      { env: { BASE_HOST } as never, req: { url: reqUrl, header: (n: string) => headers[n] } },
      'foo',
    );

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

  it('links https when TLS is terminated upstream', () => {
    // The proxy reaches the worker over plain http, so the request's own scheme
    // would hand out an http:// link to an https-only site — the URL the CLI
    // prints and the dashboard links to right after a deploy.
    expect(conn('http://brisk.example.com/api/deploy/foo', 'brisk.example.com')).toBe(
      'https://foo.brisk.example.com/',
    );
    expect(conn('http://brisk.acme.dev/api/deploy/foo', '')).toBe('https://brisk.acme.dev/s/foo/');
  });

  it('honors X-Forwarded-Proto over the guess, but only http and https', () => {
    const forwarded = (proto: string) =>
      conn('http://brisk.example.com/api/sites', 'brisk.example.com', {
        'x-forwarded-proto': proto,
      });
    expect(forwarded('https')).toBe('https://foo.brisk.example.com/');
    expect(forwarded('http')).toBe('http://foo.brisk.example.com/');
    expect(forwarded('HTTPS, http')).toBe('https://foo.brisk.example.com/');

    // Nothing strips this header on an instance no proxy fronts, and the url
    // lands in an <a href> on the dashboard: a client-chosen scheme must not.
    expect(forwarded('javascript:alert(document.domain);//')).toBe(
      'https://foo.brisk.example.com/',
    );
    expect(forwarded('')).toBe('https://foo.brisk.example.com/');
  });

  it('keeps a plain-http instance on http when TLS is implausible', () => {
    // A self-hosted box reached over http with no proxy in front: guessing https
    // hands out links that don't resolve. No public certificate can name a bare
    // IP or a private-use TLD, so neither is a hidden-TLS candidate.
    expect(conn('http://10.0.0.5:8787/api/sites', '')).toBe('http://10.0.0.5:8787/s/foo/');
    expect(conn('http://[fd00::1]:8787/api/sites', '')).toBe('http://[fd00::1]:8787/s/foo/');
    expect(conn('http://site.localhost:8787/api/sites', '')).toBe(
      'http://site.localhost:8787/s/foo/',
    );
    expect(conn('http://brisk.acme.internal:8788/api/sites', '')).toBe(
      'http://brisk.acme.internal:8788/s/foo/',
    );
    expect(conn('http://brisk.acme.internal/api/sites', 'brisk.acme.internal')).toBe(
      'http://foo.brisk.acme.internal/',
    );
    expect(conn('http://brisk.home.arpa/api/sites', '')).toBe('http://brisk.home.arpa/s/foo/');
  });

  it('judges the host the link names, not the one the request arrived on', () => {
    // A bare `proxy_pass` rewrites Host to the backend address. The path-form
    // link names that IP, so it stays http — while the OAuth origin, which
    // names BASE_HOST, does not (see auth.test.ts).
    expect(conn('http://10.0.0.5:8788/api/sites', 'brisk.example.com')).toBe(
      'http://10.0.0.5:8788/s/foo/',
    );
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
    expect(stripWidgets(await path.text())).toBe('<h1>hi</h1>');

    const subdomain = await SELF.fetch('http://greet.localhost/');
    expect(stripWidgets(await subdomain.text())).toBe('<h1>hi</h1>');

    // extensionless resolution
    const about = await SELF.fetch(`${HOST}/s/greet/about`);
    expect(stripWidgets(await about.text())).toBe('<h1>about</h1>');
  });

  it('serves a lone html page at the root and under its own name', async () => {
    await SELF.fetch(`${HOST}/api/deploy/findings`, {
      method: 'POST',
      body: deployForm({ 'db-contention-findings.html': '<h1>findings</h1>' }),
    });

    const root = await SELF.fetch(`${HOST}/s/findings/`);
    expect(root.status).toBe(200);
    expect(stripWidgets(await root.text())).toBe('<h1>findings</h1>');

    const subdomain = await SELF.fetch('http://findings.localhost/');
    expect(stripWidgets(await subdomain.text())).toBe('<h1>findings</h1>');

    const own = await SELF.fetch(`${HOST}/s/findings/db-contention-findings.html`);
    expect(stripWidgets(await own.text())).toBe('<h1>findings</h1>');
  });

  it('serves a lone .htm page as html, widgets and all', async () => {
    // The fallback matches .htm, so the mime table has to as well: stored as
    // application/octet-stream the browser downloads the page instead of
    // rendering it, and widget injection skips anything that isn't text/html.
    await SELF.fetch(`${HOST}/api/deploy/oldschool`, {
      method: 'POST',
      body: deployForm({ 'report.HTM': '<h1>legacy</h1>' }),
    });

    const root = await SELF.fetch(`${HOST}/s/oldschool/`);
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await root.text();
    expect(html).toContain('/_plugins/');
    expect(stripWidgets(html)).toBe('<h1>legacy</h1>');
  });

  it('leaves the root a 404 when which page is home is a guess', async () => {
    // Two top-level pages, or one buried in a folder: no obvious front door, so
    // the site keeps saying so instead of picking for you.
    await SELF.fetch(`${HOST}/api/deploy/pair`, {
      method: 'POST',
      body: deployForm({ 'a.html': 'a', 'b.html': 'b' }),
    });
    const pair = await SELF.fetch(`${HOST}/s/pair/`);
    expect(pair.status).toBe(404);
    expect(await pair.text()).toContain('is live');

    await SELF.fetch(`${HOST}/api/deploy/nested`, {
      method: 'POST',
      body: deployForm({ 'docs/page.html': 'buried' }),
    });
    expect((await SELF.fetch(`${HOST}/s/nested/`)).status).toBe(404);
  });

  it('returns an https url from a deploy behind a TLS-terminating proxy', async () => {
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request('http://brisk.example.com/api/deploy/proxied', {
        method: 'POST',
        body: deployForm({ 'index.html': '<h1>hi</h1>' }),
      }),
      { ...env, BASE_HOST: 'brisk.example.com' },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(await res.json<{ url: string }>()).toMatchObject({
      url: 'https://proxied.brisk.example.com/',
    });
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
    expect(stripWidgets(await (await SELF.fetch(`${HOST}/s/swap/`)).text())).toBe('v2');
    expect((await SELF.fetch(`${HOST}/s/swap/old.txt`)).status).toBe(404);
  });

  it('tells a missing path apart from a missing site', async () => {
    await SELF.fetch(`${HOST}/api/deploy/live`, {
      method: 'POST',
      body: deployForm({ 'index.html': '<h1>live</h1>' }),
    });

    // The site exists — a bad path must not invite a deploy that would overwrite it.
    const missingPath = await SELF.fetch(`${HOST}/s/live/nope`);
    expect(missingPath.status).toBe(404);
    const livePage = await missingPath.text();
    expect(livePage).toContain('is live');
    expect(livePage).not.toContain('brisk deploy --site');

    // No such site — here the claim instructions are the right answer.
    const missingSite = await SELF.fetch(`${HOST}/s/ghost/`);
    expect(missingSite.status).toBe(404);
    expect(await missingSite.text()).toContain('brisk deploy --site ghost');

    // Same split on the subdomain route.
    const subMissingPath = await SELF.fetch('http://live.localhost/nope');
    expect(await subMissingPath.text()).toContain('is live');
    const subMissingSite = await SELF.fetch('http://ghost.localhost/');
    expect(await subMissingSite.text()).toContain('brisk deploy --site ghost');
  });

  it('retains every publish as an immutable version, newest first', async () => {
    // DEPLOY_HISTORY=on: both publishes are kept (this also covers the on-retains knob).
    await deployWithHistory('ver', { 'index.html': 'first' });
    await deployWithHistory('ver', { 'index.html': 'second' });

    const deploys = await listVersions('ver');
    expect(deploys).toHaveLength(2);
    expect(deploys.map((d) => d.version)).toEqual([2, 1]);

    // Serving still follows the live pointer, which names the latest publish.
    expect(stripWidgets(await (await SELF.fetch(`${HOST}/s/ver/`)).text())).toBe('second');
  });

  it('keeps versions sequential and distinct under concurrent deploys', async () => {
    // Only the retaining (on) path leaves all versions to inspect deterministically.
    await Promise.all(
      Array.from({ length: 3 }, (_, i) => deployWithHistory('race', { 'index.html': `v${i}` })),
    );
    // The UNIQUE(site,version) index plus the retry-on-collision insert must
    // yield contiguous, non-duplicated versions no matter how the writes interleave.
    const deploys = await listVersions('race');
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
    const deploys = await listVersions('bounded');
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
    expect(await listVersions('reborn')).toHaveLength(0);

    await SELF.fetch(`${HOST}/api/deploy/reborn`, {
      method: 'POST',
      body: deployForm({ 'index.html': 'again' }),
    });
    const deploys = await listVersions('reborn');
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

  const updatedByOf = async (name: string): Promise<string | null> =>
    (await (await SELF.fetch(`${HOST}/api/sites/${name}`)).json<{ updatedBy: string | null }>())
      .updatedBy;

  it('attributes the deploy to the asserted deployer, not the auth identity', async () => {
    // On AUTH=none every request resolves to the same 'Dev' user, so the asserted
    // name is the only human attribution there is — it must drive updatedBy (the
    // dashboard's "by" column), not just the set-once owner.
    expect((await deployAs('attributed', 'alice')).status).toBe(200);
    expect(await updatedByOf('attributed')).toBe('alice');

    // A later deployer becomes the latest 'by', even as the owner stays alice.
    expect((await deployAs('attributed', 'bob', true)).status).toBe(200);
    expect(await updatedByOf('attributed')).toBe('bob');
    expect(await ownerOf('attributed')).toBe('alice');
  });

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
