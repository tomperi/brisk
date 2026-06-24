import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { siteFromHost, siteUrl } from '../src/app';
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

describe('content-type response headers', () => {
  it('serves each file with the Content-Type its extension implies', async () => {
    // deployForm hardcodes text/html on every File, but deploySite always
    // derives the stored Content-Type from the path extension — so the served
    // header must match contentType(), not the form's File.type.
    await SELF.fetch(`${HOST}/api/deploy/mimes`, {
      method: 'POST',
      body: deployForm({
        'index.html': '<h1>hi</h1>',
        'about.html': '<h1>about</h1>',
        'style.css': 'body{color:red}',
        'app.js': 'console.log(1)',
        'logo.svg': '<svg></svg>',
      }),
    });

    const cases: [string, string][] = [
      ['/s/mimes/', 'text/html; charset=utf-8'],
      ['/s/mimes/index.html', 'text/html; charset=utf-8'],
      ['/s/mimes/style.css', 'text/css; charset=utf-8'],
      ['/s/mimes/app.js', 'text/javascript; charset=utf-8'],
      ['/s/mimes/logo.svg', 'image/svg+xml'],
    ];
    for (const [path, type] of cases) {
      const res = await SELF.fetch(`${HOST}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(type);
    }

    // extensionless resolution still lands on about.html as text/html
    const about = await SELF.fetch(`${HOST}/s/mimes/about`);
    expect(about.status).toBe(200);
    expect(about.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await about.text()).toBe('<h1>about</h1>');

    // raw endpoint serves the exact file with its content-type
    const raw = await SELF.fetch(`${HOST}/api/sites/mimes/raw/style.css`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(await raw.text()).toBe('body{color:red}');
  });

  it('round-trips an upload Content-Type and keeps its safety headers', async () => {
    const form = new FormData();
    form.append('files', new File(['png-bytes'], 'pic.png', { type: 'image/png' }));
    const res = await SELF.fetch(`${HOST}/api/fs/upload`, {
      method: 'POST',
      headers: { 'x-brisk-site': 'mime-uploads' },
      body: form,
    });
    const { files } = await res.json<{ files: { url: string }[] }>();

    const served = await SELF.fetch(`${HOST}${files[0]!.url}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    // The refactor must preserve the download-safety headers on apex uploads.
    expect(served.headers.get('content-disposition')).toBe('attachment');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('realtime websocket', () => {
  // A socket wrapper with a queue + a next() that rejects on timeout, so a
  // missing message fails the test fast instead of hanging the whole suite.
  async function openSocket(site: string) {
    const res = await SELF.fetch(`${HOST}/api/ws?site=${site}`, {
      headers: { Upgrade: 'websocket' },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    const queue: unknown[] = [];
    let wake: (() => void) | null = null;
    ws.addEventListener('message', (e: MessageEvent) => {
      queue.push(JSON.parse(e.data as string));
      wake?.();
    });
    ws.accept();
    const next = (timeoutMs = 2000): Promise<any> =>
      new Promise((resolve, reject) => {
        if (queue.length) return resolve(queue.shift());
        const timer = setTimeout(() => {
          wake = null;
          reject(new Error('timed out waiting for a websocket message'));
        }, timeoutMs);
        wake = () => {
          clearTimeout(timer);
          wake = null;
          resolve(queue.shift());
        };
      });
    return { ws, next };
  }

  it('greets with the authenticated identity and delivers db events to the same site', async () => {
    const site = 'ws-db';
    const { ws, next } = await openSocket(site);

    // hello proves identity propagates through rooms.connect (x-brisk-user).
    const hello = await next();
    expect(hello.t).toBe('hello');
    expect(hello.you).toMatchObject({ email: 'dev@localhost', name: 'Dev' });

    ws.send(JSON.stringify({ t: 'db:sub', collection: 'msgs' }));

    // The db POST targets the same room via x-brisk-site (host localhost would
    // otherwise resolve to 'home'); the site and the socket's ?site must match.
    const created = await (
      await SELF.fetch(`${HOST}/api/db/msgs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-brisk-site': site },
        body: JSON.stringify({ text: 'over the wire' }),
      })
    ).json<{ id: string }>();

    const event = await next();
    expect(event).toMatchObject({
      t: 'db',
      event: 'create',
      collection: 'msgs',
      doc: { id: created.id, text: 'over the wire' },
    });

    ws.close();
  });

  it('relays a channel send with the sender identity to a second socket', async () => {
    const site = 'ws-chan';
    const a = await openSocket(site);
    const b = await openSocket(site);
    expect((await a.next()).t).toBe('hello');
    expect((await b.next()).t).toBe('hello');

    // Both join, then drain the presence broadcasts each join triggers so the
    // queues hold only the channel message we assert on next.
    a.ws.send(JSON.stringify({ t: 'join', channel: 'lobby' }));
    expect((await a.next()).t).toBe('presence');
    b.ws.send(JSON.stringify({ t: 'join', channel: 'lobby' }));
    expect((await a.next()).t).toBe('presence'); // b's join re-broadcasts to a
    expect((await b.next()).t).toBe('presence');

    a.ws.send(JSON.stringify({ t: 'send', channel: 'lobby', data: { hi: 1 } }));
    const msg = await b.next();
    expect(msg).toMatchObject({
      t: 'msg',
      channel: 'lobby',
      data: { hi: 1 },
      from: { email: 'dev@localhost' },
    });

    a.ws.close();
    b.ws.close();
  });
});
