import type { Context, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { sign, verify } from 'hono/jwt';
import type { AppEnv, User } from './env';

const SESSION_COOKIE = 'brisk_session';
const STATE_COOKIE = 'brisk_oauth_state';
const SESSION_DAYS = 7;
const CLI_TOKEN_DAYS = 90;

/** Who you are when auth is off: a trusted-network dev identity. */
const devUser = (): User => ({ email: 'dev@localhost', name: 'Dev' });

/** Hosts where an open instance is plausibly intentional (local dev). */
function isLocalHost(host: string): boolean {
  const h = host.split(':')[0]!.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h.endsWith('.localhost');
}

let warnedOpenPublic = false;
/**
 * AUTH=none on a public host serves an anonymously-writable backend on purpose —
 * but that must never be silent. Log the blast radius once per isolate so an
 * operator who set it (or inherited it) sees what they're exposing.
 */
function warnOpenPublicOnce(host: string): void {
  if (warnedOpenPublic) return;
  warnedOpenPublic = true;
  console.warn(
    `[brisk] SECURITY: AUTH=none on public host ${host} — this instance is OPEN. ` +
      `Anyone who reaches it is a full member who can deploy over or delete every ` +
      `site here and spend its AI/storage budget. Set AUTH=google to require login.`,
  );
}

/** Who you are on a VISIBILITY=public instance before signing in. */
export const VISITOR: User = { email: 'visitor', name: 'Visitor' };

export const isVisitor = (user: User): boolean => user.email === VISITOR.email;

/**
 * What a visitor may touch on a public instance: viewing, and nothing that
 * writes, costs money, or opens a websocket. `/api/sites` is the one API
 * exception (the dashboard's list); `/auth/*` past the public login routes is
 * excluded so visitors can't mint CLI tokens.
 */
function visitorAllowed(method: string, pathname: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (pathname === '/api/sites') return true;
  if (pathname.startsWith('/api/') || pathname.startsWith('/files/')) return false;
  if (pathname.startsWith('/auth/')) return false;
  return true; // static site files, dashboard assets, /brisk.js, /docs
}

const apexHost = (c: Context<AppEnv>): string => c.env.BASE_HOST || new URL(c.req.url).host;

const apexOrigin = (c: Context<AppEnv>): string => `${new URL(c.req.url).protocol}//${apexHost(c)}`;

/**
 * The session cookie is scoped to `.BASE_HOST`, so one login on the apex
 * domain covers every site subdomain — the Google-OAuth equivalent of
 * sitting behind an identity-aware proxy.
 */
function cookieDomain(c: Context<AppEnv>): string | undefined {
  const base = (c.env.BASE_HOST ?? '').split(':')[0];
  return base && base !== 'localhost' ? `.${base}` : undefined;
}

async function readSession(c: Context<AppEnv>): Promise<User | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token || !c.env.SESSION_SECRET) return null;
  try {
    const payload = await verify(token, c.env.SESSION_SECRET, 'HS256');
    return {
      email: String(payload.email),
      name: String(payload.name),
      picture: payload.picture as string | undefined,
    };
  } catch {
    return null;
  }
}

async function writeSession(c: Context<AppEnv>, user: User): Promise<void> {
  const token = await sign(
    { ...user, exp: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86_400 },
    c.env.SESSION_SECRET!, // guaranteed by the auth middleware's fail-fast
  );
  setCookie(c, SESSION_COOKIE, token, {
    domain: cookieDomain(c),
    path: '/',
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    maxAge: SESSION_DAYS * 86_400,
  });
}

const loginUrl = (c: Context<AppEnv>, next: string): string =>
  `${apexOrigin(c)}/auth/login?next=${encodeURIComponent(next)}`;

/** `next` redirects may only land on the platform itself. */
function safeNext(c: Context<AppEnv>, next: string | undefined): string {
  if (!next) return '/';
  try {
    const url = new URL(next);
    const base = apexHost(c).split(':')[0]!;
    const host = url.hostname;
    const httpish = url.protocol === 'https:' || url.protocol === 'http:';
    if (httpish && (host === base || host.endsWith(`.${base}`))) return next;
  } catch {
    // Relative path only — and not protocol-relative (`//evil.com`) or the
    // backslash variant browsers normalize to it (`/\evil.com`).
    if (next.startsWith('/') && !/^\/[\\/]/.test(next)) return next;
  }
  return '/';
}

/** Constant-time-ish bearer check: compare digests, not strings. */
async function tokenMatches(presented: string, expected: string): Promise<boolean> {
  const digest = async (s: string) =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(presented), digest(expected)]);
  return a.every((byte, i) => byte === b[i]);
}

/**
 * The OAuth guest list: exact emails (`ALLOWED_EMAILS`) and/or whole domains
 * (`ALLOWED_EMAIL_DOMAINS`), comma-separated, case-insensitive. Either list
 * admits; both empty admits anyone Google authenticates. Use exact emails for
 * personal instances — allowing `gmail.com` allows the world.
 */
export function isAllowedEmail(
  email: string,
  env: { ALLOWED_EMAILS?: string; ALLOWED_EMAIL_DOMAINS?: string },
): boolean {
  const list = (csv: string | undefined) =>
    (csv ?? '')
      .toLowerCase()
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const emails = list(env.ALLOWED_EMAILS);
  const domains = list(env.ALLOWED_EMAIL_DOMAINS);
  if (!emails.length && !domains.length) return true;
  const lower = email.toLowerCase();
  return emails.includes(lower) || domains.includes(lower.split('@')[1] ?? '');
}

const utf8ToB64 = (s: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const b64ToUtf8 = (s: string): string =>
  new TextDecoder().decode(Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0)));

/**
 * Two kinds of bearer: a personal token from `brisk login` (a JWT carrying
 * the user's identity, so deploys are attributed to a real person), or the
 * instance-wide DEPLOY_TOKEN meant for CI.
 */
async function userFromBearer(c: Context<AppEnv>, token: string): Promise<User | null> {
  try {
    const payload = await verify(token, c.env.SESSION_SECRET!, 'HS256');
    if (payload.kind === 'cli') {
      return {
        email: String(payload.email),
        name: String(payload.name),
        picture: payload.picture as string | undefined,
      };
    }
  } catch {
    /* not a personal token — fall through to the CI token */
  }
  if (c.env.DEPLOY_TOKEN && (await tokenMatches(token, c.env.DEPLOY_TOKEN))) {
    return { email: 'ci@brisk', name: 'CI (deploy token)' };
  }
  return null;
}

const CLI_CSRF_COOKIE = 'brisk_cli_csrf';

const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );

/** The localhost callback the CLI is listening on, or null if the request is malformed. */
function cliCallback(c: Context<AppEnv>): URL | null {
  const port = Number(c.req.query('port'));
  const state = c.req.query('state') ?? '';
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !state || state.length > 128) {
    return null;
  }
  const callback = new URL(`http://127.0.0.1:${port}/callback`);
  callback.searchParams.set('state', state);
  return callback;
}

async function mintCliToken(c: Context<AppEnv>, callback: URL): Promise<Response> {
  const user = c.var.user;
  const token = await sign(
    { ...user, kind: 'cli', exp: Math.floor(Date.now() / 1000) + CLI_TOKEN_DAYS * 86_400 },
    c.env.SESSION_SECRET!,
  );
  callback.searchParams.set('token', token);
  callback.searchParams.set('email', user.email);
  return c.redirect(callback.toString());
}

function consentPage(email: string, action: string, csrf: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Authorize the Brisk CLI</title>
<style>body{font:15px/1.6 ui-monospace,Menlo,monospace;display:grid;place-items:center;min-height:100vh;margin:0;background:oklch(96.5% 0.012 85);color:oklch(24% 0.015 75)}main{max-width:24rem;padding:2rem;text-align:center}h1{font-size:1.2rem}.who{color:oklch(46% 0.19 262);font-weight:700}button{font:inherit;margin-top:1.25rem;padding:.55rem 1.25rem;border:1px solid oklch(46% 0.19 262);border-radius:8px;background:oklch(46% 0.19 262);color:#fff;cursor:pointer}@media(prefers-color-scheme:dark){body{background:oklch(21% 0.012 75);color:oklch(89% 0.012 85)}}</style>
<main><h1>Authorize the Brisk CLI?</h1><p>This signs the CLI in as <span class="who">${escapeHtml(email)}</span> for 90 days on this device.</p><form method="POST" action="${escapeHtml(action)}"><input type="hidden" name="csrf" value="${csrf}"><button type="submit">Authorize</button></form></main>`;
}

/**
 * GET half of `brisk login`. A bearer caller (CI token or an existing CLI
 * token) can't be CSRF'd — browsers never attach an Authorization header
 * cross-site — so it mints directly. A browser cookie session is the CSRF-able
 * case, so it gets a consent page whose POST carries a CSRF token; a forged
 * cross-site navigation can't silently mint a 90-day act-as-you credential.
 */
export function cliConsent(): MiddlewareHandler<AppEnv> {
  return async (c) => {
    const callback = cliCallback(c);
    if (!callback) return c.text('Bad request: expected ?port= (1024-65535) and ?state=.', 400);
    if (c.env.AUTH !== 'google') {
      callback.searchParams.set('open', '1'); // this instance needs no token
      return c.redirect(callback.toString());
    }
    if (c.req.header('authorization')?.startsWith('Bearer ')) {
      return mintCliToken(c, callback);
    }
    const csrf = crypto.randomUUID();
    setCookie(c, CLI_CSRF_COOKIE, csrf, {
      path: '/auth/cli',
      httpOnly: true,
      secure: new URL(c.req.url).protocol === 'https:',
      sameSite: 'Strict',
      maxAge: 600,
    });
    const action = `/auth/cli?port=${Number(c.req.query('port'))}&state=${encodeURIComponent(c.req.query('state')!)}`;
    return c.html(consentPage(c.var.user.email, action, csrf));
  };
}

/** POST half of `brisk login`: mints the token after the consent page's
 *  same-origin, CSRF-checked submit. */
export function cliMint(): MiddlewareHandler<AppEnv> {
  return async (c) => {
    const callback = cliCallback(c);
    if (!callback) return c.text('Bad request: expected ?port= (1024-65535) and ?state=.', 400);
    if (c.env.AUTH !== 'google') {
      callback.searchParams.set('open', '1');
      return c.redirect(callback.toString());
    }
    const cookie = getCookie(c, CLI_CSRF_COOKIE);
    const body = await c.req.parseBody();
    const field = typeof body['csrf'] === 'string' ? body['csrf'] : '';
    if (!cookie || !field || cookie !== field) {
      return c.text('Authorization failed (CSRF check). Restart `brisk login`.', 403);
    }
    deleteCookie(c, CLI_CSRF_COOKIE, { path: '/auth/cli' });
    return mintCliToken(c, callback);
  };
}

/**
 * Resolves the requesting user. With AUTH=google: session cookie or a CLI
 * bearer token; unauthenticated browsers get bounced to Google, APIs get 401.
 */
export function auth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.env.AUTH !== 'google') {
      const host = new URL(c.req.url).host;
      const local = isLocalHost(host);
      // AUTH=none is "trusted network", fine locally. But Workers are public by
      // default, so an *unset* AUTH on a public host is almost always a forgotten
      // config that would ship an open, anonymously-writable backend. Fail closed
      // there and point at the secure setup; require an explicit AUTH=none to run
      // open on purpose.
      if (!c.env.AUTH && !local) {
        return c.text(
          'Refusing to serve an open backend on a public host.\n\n' +
            'Set AUTH=google to require login (recommended). Without it, anyone who\n' +
            'reaches this host is a full member who can deploy over or delete every\n' +
            'site here and spend its AI/storage budget. From the worker directory:\n' +
            '  npx wrangler secret put SESSION_SECRET        # any long random string\n' +
            '  npx wrangler secret put GOOGLE_CLIENT_ID\n' +
            '  npx wrangler secret put GOOGLE_CLIENT_SECRET\n' +
            'then set AUTH=google and an ALLOWED_EMAILS / ALLOWED_EMAIL_DOMAINS\n' +
            'allowlist. Add VISIBILITY=public to let strangers view (not touch) it.\n\n' +
            'To run an open instance on purpose (a trusted/local network only), set\n' +
            'AUTH=none explicitly.',
          503,
        );
      }
      // An explicit AUTH=none on a public host is open "on purpose" — but it serves
      // an anonymously-writable backend to the whole internet, so never let it be
      // silent.
      if (c.env.AUTH === 'none' && !local) warnOpenPublicOnce(host);
      c.set('user', devUser());
      return next();
    }
    if (!c.env.SESSION_SECRET) {
      return c.text('Misconfigured: AUTH=google requires the SESSION_SECRET secret.', 500);
    }

    const bearer = c.req.header('authorization');
    if (bearer?.startsWith('Bearer ')) {
      const user = await userFromBearer(c, bearer.slice(7));
      if (user) {
        c.set('user', user);
        return next();
      }
    }

    const user = await readSession(c);
    if (user) {
      c.set('user', user);
      return next();
    }

    if (
      c.env.VISIBILITY === 'public' &&
      visitorAllowed(c.req.method, new URL(c.req.url).pathname)
    ) {
      c.set('user', VISITOR);
      return next();
    }

    const wantsHtml =
      c.req.method === 'GET' &&
      (c.req.header('sec-fetch-dest') === 'document' ||
        (c.req.header('accept') ?? '').includes('text/html'));
    return wantsHtml
      ? c.redirect(loginUrl(c, c.req.url))
      : c.json({ error: 'unauthenticated' }, 401);
  };
}

/** /auth/login → Google → /auth/callback → session cookie → back to `next`. */
export function authRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/auth/login', (c) => {
    if (c.env.AUTH !== 'google') return c.redirect('/');
    const state = `${crypto.randomUUID()}.${utf8ToB64(safeNext(c, c.req.query('next')))}`;
    setCookie(c, STATE_COOKIE, state, {
      path: '/auth',
      httpOnly: true,
      secure: new URL(c.req.url).protocol === 'https:',
      sameSite: 'Lax',
      maxAge: 600,
    });
    const params = new URLSearchParams({
      client_id: c.env.GOOGLE_CLIENT_ID ?? '',
      redirect_uri: `${apexOrigin(c)}/auth/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
    });
    return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  app.get('/auth/callback', async (c) => {
    const state = c.req.query('state');
    const code = c.req.query('code');
    if (!code || !state || state !== getCookie(c, STATE_COOKIE)) {
      return c.text('OAuth state mismatch — try logging in again.', 400);
    }
    deleteCookie(c, STATE_COOKIE, { path: '/auth' });

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: c.env.GOOGLE_CLIENT_ID ?? '',
        client_secret: c.env.GOOGLE_CLIENT_SECRET ?? '',
        redirect_uri: `${apexOrigin(c)}/auth/callback`,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) return c.text('Google token exchange failed.', 502);
    const { id_token } = await tokenRes.json<{ id_token: string }>();

    // The id_token came straight from Google over TLS; decoding is enough.
    const claims = JSON.parse(
      b64ToUtf8(id_token.split('.')[1]!.replaceAll('-', '+').replaceAll('_', '/')),
    ) as {
      email: string;
      name?: string;
      picture?: string;
    };

    if (!isAllowedEmail(claims.email, c.env)) {
      return c.text(`Sorry, ${claims.email} isn't allowed on this Brisk instance.`, 403);
    }

    await writeSession(c, {
      email: claims.email,
      name: claims.name ?? claims.email,
      picture: claims.picture,
    });
    return c.redirect(safeNext(c, b64ToUtf8(state.split('.')[1] ?? '')));
  });

  app.get('/auth/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/', domain: cookieDomain(c) });
    return c.redirect('/');
  });

  return app;
}
