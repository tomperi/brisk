import type { Context, Hono, MiddlewareHandler } from 'hono';
import type { AppEnv, User } from './env';
import type { Database } from './platform/types';
import { getSite, isValidSiteName, siteFromHost } from './sites';

/**
 * Site tokens: long-lived bearer credentials for CI and scripts, limited to
 * exact site names and CRUD scopes. A token's own requests never leave its
 * sites; but write/update can ship JS that then runs as any member who views it.
 */

export const SCOPES = ['read', 'write', 'update', 'delete'] as const;
export type Scope = (typeof SCOPES)[number];

/** Every secret starts with this, so the bearer check can tell it apart from a
 *  CLI JWT and the DEPLOY_TOKEN without a database read. */
export const TOKEN_PREFIX = 'brisk_';

const MAX_LABEL = 80;
const MAX_SITES = 20;
const TOUCH_EVERY_MS = 60_000;

export interface SiteToken {
  id: string;
  label: string;
  sites: string[];
  scopes: Scope[];
  disabled: boolean;
  createdAt: string;
  createdBy: string;
  lastUsedAt: string | null;
}

interface TokenRow {
  id: string;
  label: string;
  sites: string;
  scopes: string;
  disabled: number;
  created_at: string;
  created_by: string;
  last_used_at: string | null;
}

const COLUMNS = 'id, label, sites, scopes, disabled, created_at, created_by, last_used_at';

const toToken = (row: TokenRow): SiteToken => ({
  id: row.id,
  label: row.label,
  sites: JSON.parse(row.sites) as string[],
  scopes: JSON.parse(row.scopes) as Scope[],
  disabled: row.disabled === 1,
  createdAt: row.created_at,
  createdBy: row.created_by,
  lastUsedAt: row.last_used_at,
});

const randomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

const sha256 = async (s: string): Promise<string> =>
  hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));

/** The identity a site token acts as: its label is the deploy owner/updatedBy. */
export const tokenUser = (token: SiteToken): User => ({
  email: `${token.id}@token`,
  name: token.label,
});

export interface TokenInput {
  label: string;
  sites: string[];
  scopes: Scope[];
}

/** Validates a create request; returns the problem as a string on failure. */
export function parseTokenInput(body: unknown): TokenInput | string {
  const { label, sites, scopes } = (body ?? {}) as Record<string, unknown>;
  const name = typeof label === 'string' ? label.trim() : '';
  if (!name || name.length > MAX_LABEL) return `label must be 1-${MAX_LABEL} characters`;
  if (!Array.isArray(sites) || !sites.length || sites.length > MAX_SITES) {
    return `sites must list 1-${MAX_SITES} site names`;
  }
  const bad = sites.find((s) => typeof s !== 'string' || !isValidSiteName(s));
  if (bad !== undefined) return `invalid site name: ${JSON.stringify(bad)}`;
  if (!Array.isArray(scopes) || !scopes.length) {
    return `scopes must list one or more of ${SCOPES.join(', ')}`;
  }
  const unknown = scopes.find((s) => !SCOPES.includes(s as Scope));
  if (unknown !== undefined) return `unknown scope: ${JSON.stringify(unknown)}`;
  return {
    label: name,
    sites: [...new Set(sites as string[])],
    scopes: SCOPES.filter((s) => scopes.includes(s)),
  };
}

export async function createToken(
  db: Database,
  input: TokenInput,
  createdBy: string,
): Promise<{ token: SiteToken; secret: string }> {
  const secret = TOKEN_PREFIX + base64url(randomBytes(32));
  const token: SiteToken = {
    id: `tok_${hex(randomBytes(6))}`,
    ...input,
    disabled: false,
    createdAt: new Date().toISOString(),
    createdBy,
    lastUsedAt: null,
  };
  await db
    .prepare(
      `INSERT INTO tokens (id, hash, label, sites, scopes, disabled, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .bind(
      token.id,
      await sha256(secret),
      token.label,
      JSON.stringify(token.sites),
      JSON.stringify(token.scopes),
      token.createdAt,
      createdBy,
    )
    .run();
  return { token, secret };
}

export async function listTokens(db: Database): Promise<SiteToken[]> {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM tokens ORDER BY created_at DESC`)
    .all<TokenRow>();
  return results.map(toToken);
}

async function getToken(db: Database, id: string): Promise<SiteToken | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM tokens WHERE id = ?`)
    .bind(id)
    .first<TokenRow>();
  return row ? toToken(row) : null;
}

export async function findTokenBySecret(db: Database, secret: string): Promise<SiteToken | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM tokens WHERE hash = ?`)
    .bind(await sha256(secret))
    .first<TokenRow>();
  return row ? toToken(row) : null;
}

/** Records use at most once a minute, so a busy CI job isn't a write per request. */
export function touchToken(c: Context<AppEnv>, token: SiteToken): void {
  const now = Date.now();
  if (token.lastUsedAt && now - Date.parse(token.lastUsedAt) < TOUCH_EVERY_MS) return;
  c.var.platform.waitUntil(
    c.var.platform.db
      .prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?')
      .bind(new Date(now).toISOString(), token.id)
      .run(),
  );
}

interface Need {
  site: string;
  /** `deploy` resolves to write (new site) or update (existing site). */
  scope: Scope | 'deploy';
}

/**
 * What a request needs from a site token, or null when no token may make it.
 * `path` must be Hono's routing path (`c.req.path`), so a percent-encoded path
 * can't be classified as one route and dispatched as another.
 */
export function tokenNeed(
  method: string,
  path: string,
  apiSite: string,
  hostSite: string | null,
): Need | null {
  const read = method === 'GET' || method === 'HEAD';
  const named = (segment: string, scope: Need['scope']): Need | null => {
    try {
      return { site: decodeURIComponent(segment), scope };
    } catch {
      return null;
    }
  };
  let m: RegExpExecArray | null;

  if ((m = /^\/api\/db(?:\/([^/]+)(?:\/([^/]+))?)?$/.exec(path))) {
    const [, collection, id] = m;
    if (read) return { site: apiSite, scope: 'read' };
    if (method === 'POST' && collection && !id) return { site: apiSite, scope: 'write' };
    if (method === 'PATCH' && id) return { site: apiSite, scope: 'update' };
    if (method === 'DELETE' && id) return { site: apiSite, scope: 'delete' };
    return null;
  }
  if (path === '/api/fs/upload')
    return method === 'POST' ? { site: apiSite, scope: 'write' } : null;
  if ((m = /^\/api\/deploy\/([^/]+)$/.exec(path))) {
    return method === 'POST' ? named(m[1]!, 'deploy') : null;
  }
  if ((m = /^\/api\/sites\/([^/]+)(\/files|\/raw\/.*)?$/.exec(path))) {
    if (read) return named(m[1]!, 'read');
    return method === 'DELETE' && !m[2] ? named(m[1]!, 'delete') : null;
  }
  if ((m = /^\/files\/([^/]+)\/[^/]+\/[^/]+$/.exec(path)))
    return read ? named(m[1]!, 'read') : null;
  if ((m = /^\/s\/([^/]+)(?:\/.*)?$/.exec(path))) return read ? named(m[1]!, 'read') : null;
  if (/^\/(api|auth|files|_plugins|s)(\/|$)/.test(path)) return null;
  // A page on a site's own host. The apex (the dashboard) is never a token's.
  return read && hostSite ? { site: hostSite, scope: 'read' } : null;
}

/**
 * Deny-by-default gate for site-token requests. It runs before every route, so a
 * route added later is closed to tokens until tokenNeed names it.
 */
export function siteTokenGate(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = c.var.siteToken;
    if (!token) return next();
    const method = c.req.method;
    if ((method === 'GET' || method === 'HEAD') && c.req.path === '/api/me') return next();

    const hostSite = siteFromHost(new URL(c.req.url).host, c.env.BASE_HOST);
    const need = tokenNeed(method, c.req.path, c.var.site, hostSite);
    if (!need) {
      return c.json({ error: 'site tokens cannot call this route', code: 'token-route' }, 403);
    }
    if (!token.sites.includes(need.site)) {
      return c.json(
        { error: `token ${token.id} is not allowed on site "${need.site}"`, code: 'token-site' },
        403,
      );
    }
    // Deploys fail fast here, before the upload; the route checks again after it.
    const scope =
      need.scope === 'deploy'
        ? (await getSite(c.var.platform, need.site))
          ? 'update'
          : 'write'
        : need.scope;
    if (!token.scopes.includes(scope)) return scopeDenied(c, token, scope);
    return next();
  };
}

export const scopeDenied = (c: Context<AppEnv>, token: SiteToken, scope: Scope): Response =>
  c.json({ error: `token ${token.id} lacks the "${scope}" scope`, code: 'token-scope' }, 403);

/**
 * Every site is also served from the dashboard's origin (/s/<site>/), so a site's
 * script can call these routes with the viewer's session cookie and read the
 * answer. A personal CLI token is out of a page's reach.
 */
function cliOnly(c: Context<AppEnv>, action: string, command: string): Response {
  return c.json(
    {
      error:
        `${action} needs your personal token from \`brisk login\` ` +
        `(run: brisk token ${command}), not a browser session or another token`,
      code: 'cli-only',
    },
    403,
  );
}

/** Members manage tokens. Site tokens never reach these routes (the gate). */
export function registerTokenRoutes(app: Hono<AppEnv>): void {
  app.get('/api/tokens', async (c) => c.json({ tokens: await listTokens(c.var.platform.db) }));

  app.post('/api/tokens', async (c) => {
    if (c.var.credential === 'dev') {
      return c.json(
        { error: 'site tokens need AUTH=google: on an open instance every request is a member' },
        400,
      );
    }
    if (c.var.credential !== 'cli') return cliOnly(c, 'creating a site token', 'create');
    const input = parseTokenInput(await c.req.json().catch(() => null));
    if (typeof input === 'string') return c.json({ error: input }, 400);
    return c.json(await createToken(c.var.platform.db, input, c.var.user.email), 201);
  });

  app.patch('/api/tokens/:id', async (c) => {
    const body = await c.req.json<{ disabled?: unknown }>().catch(() => null);
    if (typeof body?.disabled !== 'boolean') {
      return c.json({ error: 'expected { "disabled": true | false }' }, 400);
    }
    // Disabling is incident response and stays one click away; enabling would
    // let a hostile page revive a token someone just cut off.
    if (!body.disabled && c.var.credential !== 'cli') {
      return cliOnly(c, 'enabling a site token', `enable ${c.req.param('id')}`);
    }
    const db = c.var.platform.db;
    const id = c.req.param('id');
    const { meta } = await db
      .prepare('UPDATE tokens SET disabled = ? WHERE id = ?')
      .bind(body.disabled ? 1 : 0, id)
      .run();
    if (!meta.changes) return c.json({ error: 'token not found' }, 404);
    return c.json(await getToken(db, id));
  });

  app.delete('/api/tokens/:id', async (c) => {
    const { meta } = await c.var.platform.db
      .prepare('DELETE FROM tokens WHERE id = ?')
      .bind(c.req.param('id'))
      .run();
    if (!meta.changes) return c.json({ error: 'token not found' }, 404);
    return c.json({ ok: true });
  });
}
