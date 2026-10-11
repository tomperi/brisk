import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { sign } from 'hono/jwt';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { isAllowedEmail } from '../src/auth';
import { buildCloudflarePlatform } from '../src/platform/cloudflare/platform';

const app = createApp((c) => buildCloudflarePlatform(c.env, c.executionCtx));

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
  return fetchUrl(authEnv, `http://localhost${path}`, init);
}

/** Like fetchAs, but takes an absolute URL so tests can control the host. */
async function fetchUrl(authEnv: typeof env, url: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(url, init), authEnv, ctx);
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

  it('serves /llms.txt with no session, and only ever the platform file', async () => {
    // The page exists for agents that can't log in, so a private instance
    // answers it — but a deployed site named `home` shadows the dashboard, and
    // must not get to publish a file under that name (or its `.html` twin) to
    // the world through the same door.
    const form = new FormData();
    form.append('files', new File(['NOT-THE-PLATFORM-FILE'], 'llms.txt'));
    form.append('files', new File(['NOT-THE-PLATFORM-FILE'], 'llms.txt.html'));
    form.append('files', new File(['<h1>home</h1>'], 'index.html'));
    const ci = { authorization: 'Bearer ci-token' };
    const deployed = await fetchAs(googleEnv, '/api/deploy/home', {
      method: 'POST',
      headers: ci,
      body: form,
    });
    expect(deployed.status).toBe(200);
    try {
      const platform = async (res: Response) => {
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/plain');
        expect((await res.text()).startsWith('# Brisk\n')).toBe(true);
      };
      await platform(await fetchAs(googleEnv, '/llms.txt'));
      // The SDK header can't steer it onto a site, and a member sees the same.
      await platform(
        await fetchAs(googleEnv, '/llms.txt', { headers: { 'x-brisk-site': 'home' } }),
      );
      await platform(await fetchAs(googleEnv, '/llms.txt', { headers: ci }));
      // On a site's own host the path is that site's file: members only.
      expect((await fetchUrl(googleEnv, 'http://home.localhost/llms.txt')).status).toBe(401);
      expect((await fetchUrl(googleEnv, 'http://somesite.localhost/llms.txt')).status).toBe(401);
      // The rest of the deployed home site stays behind login.
      expect((await fetchAs(googleEnv, '/index.html')).status).toBe(401);
    } finally {
      await fetchAs(googleEnv, '/api/sites/home', { method: 'DELETE', headers: ci });
    }
  });

  it('builds an https OAuth redirect_uri when TLS is terminated upstream', async () => {
    // Behind a TLS-terminating reverse proxy that doesn't forward the scheme, the
    // app is reached over plain http though the public origin is https. redirect_uri
    // must be https or Google 400s with redirect_uri_mismatch.
    const res = await fetchUrl(googleEnv, 'http://brisk.example.com/auth/login');
    expect(res.status).toBe(302);
    const google = new URL(res.headers.get('location')!);
    expect(google.host).toBe('accounts.google.com');
    expect(google.searchParams.get('redirect_uri')).toBe('https://brisk.example.com/auth/callback');
  });

  it('builds the redirect_uri from the host it names, not the one it arrived on', async () => {
    // A bare `proxy_pass http://10.0.0.5:8788;` rewrites Host to the backend
    // address and sends no X-Forwarded-Proto. The origin still names BASE_HOST,
    // so judging the IP would emit http:// for an https instance and Google
    // would answer redirect_uri_mismatch — login impossible.
    const behindRewritingProxy = { ...googleEnv, BASE_HOST: 'brisk.example.com' };
    const res = await fetchUrl(behindRewritingProxy, 'http://10.0.0.5:8788/auth/login');
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).searchParams.get('redirect_uri')).toBe(
      'https://brisk.example.com/auth/callback',
    );

    // The same request with no BASE_HOST names the IP itself, where http is right.
    const bare = await fetchUrl(googleEnv, 'http://10.0.0.5:8788/auth/login');
    expect(new URL(bare.headers.get('location')!).searchParams.get('redirect_uri')).toBe(
      'http://10.0.0.5:8788/auth/callback',
    );
  });

  it('honors X-Forwarded-Proto and keeps localhost on http for dev', async () => {
    const forwarded = await fetchUrl(googleEnv, 'http://brisk.example.com/auth/login', {
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(new URL(forwarded.headers.get('location')!).searchParams.get('redirect_uri')).toBe(
      'https://brisk.example.com/auth/callback',
    );

    const local = await fetchUrl(googleEnv, 'http://localhost/auth/login');
    expect(new URL(local.headers.get('location')!).searchParams.get('redirect_uri')).toBe(
      'http://localhost/auth/callback',
    );
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

  it('requires a CSRF-checked POST to mint a token for a browser cookie session', async () => {
    const session = await sign(
      { email: 'tom@yourco.com', name: 'Tom', exp: Math.floor(Date.now() / 1000) + 3600 },
      'test-secret',
    );
    const cookie = `brisk_session=${session}`;

    // GET returns a consent page (not a token) and sets a CSRF cookie.
    const consent = await fetchAs(googleEnv, '/auth/cli?port=4444&state=abc', {
      headers: { cookie },
    });
    expect(consent.status).toBe(200);
    expect(consent.headers.get('set-cookie')).toContain('brisk_cli_csrf');
    const csrf = (await consent.text()).match(/name="csrf" value="([^"]+)"/)?.[1];
    expect(csrf).toBeTruthy();

    // A forged POST without the CSRF token is refused.
    const forged = await fetchAs(googleEnv, '/auth/cli?port=4444&state=abc', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: '',
    });
    expect(forged.status).toBe(403);

    // The consent page's own submit (matching CSRF cookie + field) mints.
    const minted = await fetchAs(googleEnv, '/auth/cli?port=4444&state=abc', {
      method: 'POST',
      headers: {
        cookie: `${cookie}; brisk_cli_csrf=${csrf}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: `csrf=${csrf}`,
    });
    expect(minted.status).toBe(302);
    expect(new URL(minted.headers.get('location')!).searchParams.get('token')).toBeTruthy();
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

  it('lets visitors read /llms.txt (as any GET outside the API would be)', async () => {
    const res = await fetchAs(publicEnv, '/llms.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect((await res.text()).startsWith('# Brisk\n')).toBe(true);
  });

  it('ignores x-brisk-site for static serving — no cache poisoning', async () => {
    for (const [name, html] of [
      ['victimsite', 'VICTIM-CONTENT'],
      ['evilsite', 'EVIL-CONTENT'],
    ]) {
      const form = new FormData();
      form.append('files', new File([html], 'index.html'));
      await fetchAs(publicEnv, `/api/deploy/${name}`, {
        method: 'POST',
        headers: { authorization: 'Bearer ci-token' },
        body: form,
      });
    }

    // A visitor tries to serve (and cache) evil content under the victim's URL.
    const poison = await fetchUrl(publicEnv, 'http://victimsite.localhost/', {
      headers: { 'x-brisk-site': 'evilsite' },
    });
    expect(await poison.text()).toBe('VICTIM-CONTENT');

    // The next, header-less visitor must not get the poisoned copy from cache.
    const innocent = await fetchUrl(publicEnv, 'http://victimsite.localhost/');
    expect(await innocent.text()).toBe('VICTIM-CONTENT');
  });

  it("keeps one visitor's X-Forwarded-Proto out of the next visitor's links", async () => {
    const form = new FormData();
    form.append('files', new File(['<h1>ok</h1>'], 'index.html'));
    await fetchAs(publicEnv, '/api/deploy/listed', {
      method: 'POST',
      headers: { authorization: 'Bearer ci-token' },
      body: form,
    });
    const urlsOf = async (res: Response) =>
      (await res.json<{ sites: { url: string }[] }>()).sites.map((s) => s.url);

    // The site list is cached for visitors, and every url in it carries the
    // scheme derived from *that* request's headers. A visitor asking for http
    // gets http — and must not leave it behind for everyone else.
    const asked = await fetchUrl(publicEnv, 'http://brisk.example.com/api/sites', {
      headers: { 'x-forwarded-proto': 'http' },
    });
    expect((await urlsOf(asked)).every((url) => url.startsWith('http://'))).toBe(true);

    const innocent = await fetchUrl(publicEnv, 'http://brisk.example.com/api/sites');
    expect((await urlsOf(innocent)).every((url) => url.startsWith('https://'))).toBe(true);

    // A scheme the header may not carry never reaches the body at all —
    // app.js assigns site.url straight to an anchor's href. Sent to a host
    // nothing has cached yet, so the body is genuinely rebuilt with the forged
    // header present: keyed against a warm cache this assertion would be
    // answered by the innocent request's stored copy and pin nothing.
    const forged = await fetchUrl(publicEnv, 'http://cold.brisk.example.com/api/sites', {
      headers: { 'x-forwarded-proto': 'javascript:alert(document.domain);//' },
    });
    expect((await urlsOf(forged)).every((url) => url.startsWith('https://'))).toBe(true);
  });

  it('keys the cached list by port, so :443 cannot collapse onto the clean host', async () => {
    const form = new FormData();
    form.append('files', new File(['<h1>ok</h1>'], 'index.html'));
    await fetchAs(publicEnv, '/api/deploy/ported', {
      method: 'POST',
      headers: { authorization: 'Bearer ci-token' },
      body: form,
    });
    const urlsOf = async (res: Response) =>
      (await res.json<{ sites: { url: string }[] }>()).sites.map((s) => s.url);

    // The Node assembly builds the request URL straight from Host, so a visitor
    // can arrive as `host:443`. Keying the scheme by mutating url.protocol drops
    // that port — https's default — filing this body under the clean host's key.
    const ported = await fetchUrl(publicEnv, 'http://brisk.example.com:443/api/sites');
    expect((await urlsOf(ported)).every((url) => url.includes(':443/s/'))).toBe(true);

    const clean = await fetchUrl(publicEnv, 'http://brisk.example.com/api/sites');
    expect((await urlsOf(clean)).some((url) => url.includes(':443'))).toBe(false);
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

describe('AUTH unset (secure by default)', () => {
  const unsetEnv = { ...env, AUTH: undefined } as unknown as typeof env;

  it('fails closed on a public host', async () => {
    const res = await fetchUrl(unsetEnv, 'https://brisk.example.com/api/me');
    expect(res.status).toBe(503);
    // the 503 must point operators at the secure path, not just say "no".
    const body = await res.text();
    expect(body).toContain('Refusing to serve an open backend');
    expect(body).toContain('AUTH=google');
  });

  it('still grants the dev identity on localhost', async () => {
    const res = await fetchUrl(unsetEnv, 'http://localhost/api/me');
    expect(res.status).toBe(200);
  });

  it('honors an explicit AUTH=none even on a public host', async () => {
    const res = await fetchUrl(
      { ...env, AUTH: 'none' as const },
      'https://brisk.example.com/api/me',
    );
    expect(res.status).toBe(200);
  });
});

describe('AUTH typos never silently open (fail closed)', () => {
  const withAuth = (auth: string) => ({ ...env, AUTH: auth }) as unknown as typeof env;

  // Only a literal `google`/`none` is honored. A mis-cased (`Google`) or
  // misspelled (`googl`) value must NOT slip past the `=== 'google'` gate into
  // an open, anonymously-writable backend on a public host — it fails closed
  // with the same 503 as an unset AUTH.
  for (const typo of ['Google', 'GOOGLE', 'googl', 'None', 'nonsense']) {
    it(`503s a public host for AUTH=${JSON.stringify(typo)}`, async () => {
      const res = await fetchUrl(withAuth(typo), 'https://brisk.example.com/api/me');
      expect(res.status).toBe(503);
      expect(await res.text()).toContain('Refusing to serve an open backend');
    });
  }

  // The tightening must not break local dev: a typo on localhost still gets the
  // trusted dev identity, exactly like an unset AUTH did.
  it('still grants the dev identity for a typo on localhost', async () => {
    const res = await fetchUrl(withAuth('Google'), 'http://localhost/api/me');
    expect(res.status).toBe(200);
  });

  // Whitespace is the common dashboard/.env footgun: a stray space is trimmed,
  // so `AUTH=google ` means google — login required (401), never an open 200.
  it('trims whitespace so "google " requires login, not an open backend', async () => {
    const res = await fetchUrl(
      { ...googleEnv, AUTH: 'google ' } as unknown as typeof env,
      'https://brisk.example.com/api/me',
    );
    expect(res.status).toBe(401);
  });
});
