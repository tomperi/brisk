import type { Context, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { sign, verify } from 'hono/jwt';
import type { AppEnv, User } from './env';

const SESSION_COOKIE = 'brisk_session';
const STATE_COOKIE = 'brisk_oauth_state';
const SESSION_DAYS = 7;

/** Who you are when auth is off: a trusted-network dev identity. */
export const devUser = (): User => ({ email: 'dev@localhost', name: 'Dev' });

const apexHost = (c: Context<AppEnv>): string => c.env.BASE_HOST || new URL(c.req.url).host;

const apexOrigin = (c: Context<AppEnv>): string => `${new URL(c.req.url).protocol}//${apexHost(c)}`;

/**
 * The session cookie is scoped to `.BASE_HOST`, so one login on the apex
 * domain covers every site subdomain — the Google-OAuth equivalent of
 * sitting behind an identity-aware proxy.
 */
function cookieDomain(c: Context<AppEnv>): string | undefined {
  const base = c.env.BASE_HOST.split(':')[0];
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
    c.env.SESSION_SECRET!,
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
    if (host === base || host.endsWith(`.${base}`)) return next;
  } catch {
    if (next.startsWith('/')) return next;
  }
  return '/';
}

/**
 * Resolves the requesting user. With AUTH=google: session cookie or a CLI
 * bearer token; unauthenticated browsers get bounced to Google, APIs get 401.
 */
export function auth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.env.AUTH !== 'google') {
      c.set('user', devUser());
      return next();
    }

    const bearer = c.req.header('authorization');
    if (
      bearer?.startsWith('Bearer ') &&
      c.env.DEPLOY_TOKEN &&
      bearer.slice(7) === c.env.DEPLOY_TOKEN
    ) {
      c.set('user', { email: 'cli@brisk', name: 'CLI (deploy token)' });
      return next();
    }

    const user = await readSession(c);
    if (user) {
      c.set('user', user);
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
    const state = `${crypto.randomUUID()}.${btoa(safeNext(c, c.req.query('next')))}`;
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
      atob(id_token.split('.')[1]!.replaceAll('-', '+').replaceAll('_', '/')),
    ) as {
      email: string;
      name?: string;
      picture?: string;
    };

    const allowed = c.env.ALLOWED_EMAIL_DOMAINS.split(',')
      .map((d) => d.trim())
      .filter(Boolean);
    const domain = claims.email.split('@')[1] ?? '';
    if (allowed.length && !allowed.includes(domain)) {
      return c.text(`Sorry, ${claims.email} isn't allowed on this Brisk instance.`, 403);
    }

    await writeSession(c, {
      email: claims.email,
      name: claims.name ?? claims.email,
      picture: claims.picture,
    });
    return c.redirect(safeNext(c, atob(state.split('.')[1] ?? '')));
  });

  app.get('/auth/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/', domain: cookieDomain(c) });
    return c.redirect('/');
  });

  return app;
}
