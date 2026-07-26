import { Hono, type Context, type Handler, type MiddlewareHandler } from 'hono';
import { AiNotConfiguredError, chat } from './ai';
import { auth, authRoutes, cliConsent, cliMint, isVisitor } from './auth';
import { DocStore } from './docs';
import { contentType } from './mime';
import {
  deleteSite,
  deploySite,
  getFile,
  getSite,
  isValidSiteName,
  listFiles,
  listSites,
  serveSite,
  sitePlugins,
  type DeployFile,
} from './sites';
import type { AppEnv, Env } from './env';
import type { DbEvent, Platform } from './platform/types';
import { PLUGINS } from './plugins';
import { resolveEnabled, withMandatory } from './plugins/resolve';
import { registerPluginRoutes } from './plugins/routes';
import { injectWidgets } from './plugins/inject';
import { PLUGIN_COLLECTION_PREFIX, type Plugin } from './plugins/types';

const MAX_DEPLOY_FILES = 2000;

/** A site's files (one deploy) and any single upload both cap at 10 MB — keeps
 *  a leaked token or runaway script from filling the R2 free tier. */
const MAX_SITE_BYTES = 10 * 1024 * 1024;
const tooLarge = (bytes: number): boolean => bytes > MAX_SITE_BYTES;

/** Every File in the form's `files` field, whatever Hono parsed it into. */
function formFiles(body: Record<string, unknown>): File[] {
  const raw = body['files'];
  return (Array.isArray(raw) ? raw : [raw]).filter((f): f is File => f instanceof File);
}

/** The site's brisk.json `plugins` map, sent by the CLI as an x-brisk-plugins
 *  header. Malformed input is ignored (deploys never fail over a bad map). */
function parseRequestedPlugins(header: string | undefined): Record<string, boolean> {
  if (!header) return {};
  try {
    const value = JSON.parse(header);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: Record<string, boolean> = {};
    for (const [id, on] of Object.entries(value)) if (typeof on === 'boolean') out[id] = on;
    return out;
  } catch {
    return {};
  }
}

/**
 * `foo.brisk.example.com` → `foo`. `foo.localhost` always works too, whatever
 * BASE_HOST says — local dev shouldn't depend on production config.
 */
export function siteFromHost(host: string, baseHost = ''): string | null {
  const bare = host.split(':')[0]!.toLowerCase();
  const bases = [...new Set([baseHost.split(':')[0]!.toLowerCase(), 'localhost'])].filter(Boolean);
  for (const base of bases) {
    if (bare === base) return null;
    if (bare.endsWith(`.${base}`)) {
      const label = bare.slice(0, -(base.length + 1));
      return label.includes('.') ? null : label;
    }
  }
  return null;
}

/**
 * Site URLs adapt to however the requester reached the instance: subdomain
 * form only when the request actually came through BASE_HOST, path form on
 * any other host (localhost, workers.dev, a self-hoster's alternate domain).
 * Otherwise local dev would hand out production links.
 */
export function siteUrl(c: { env: Env; req: { url: string } }, site: string): string {
  const url = new URL(c.req.url);
  const base = c.env.BASE_HOST;
  const viaBase = base && (url.host === base || url.host.endsWith(`.${base}`));
  return viaBase ? `${url.protocol}//${site}.${base}/` : `${url.protocol}//${url.host}/s/${site}/`;
}

/**
 * Visitors on a public instance get edge-cached responses, so a busy demo
 * costs ~zero R2/D1 operations; members always see fresh data. The cache key
 * drops the query string — site files and the sites list don't vary by it, and
 * keeping it would let `?x=<random>` bust the cache on every request.
 */
async function visitorCached(
  c: Context<AppEnv>,
  build: () => Promise<Response | null>,
  maxAge = 300,
  cacheSite = '',
): Promise<Response | null> {
  if (!isVisitor(c.var.user)) return build();
  const url = new URL(c.req.raw.url);
  url.search = '';
  // Key on the actually-served site, not just the URL. Otherwise a visitor who
  // picks a site via x-brisk-site could cache its content under another site's
  // URL, and the next header-less visitor would be served the poisoned copy.
  if (cacheSite) url.searchParams.set('__site', cacheSite);
  const key = url.toString();
  const cache = c.var.platform.cache;
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await build();
  if (!res) return null;
  // Buffer the body so the cached copy doesn't keep the storage stream open.
  const body = await res.arrayBuffer();
  const headers = new Headers(res.headers);
  headers.set('cache-control', `public, max-age=${maxAge}`);
  c.var.platform.waitUntil(cache.put(key, new Response(body.slice(0), { headers })));
  return new Response(body, { headers });
}

export function createApp(
  makePlatform: (c: Context<AppEnv>) => Platform,
  wsRoute?: MiddlewareHandler<AppEnv>,
  plugins: Plugin[] = PLUGINS,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Inject the platform first so every route — including the mounted auth
  // routes — can reach storage/db/rooms/cache via c.var.platform.
  app.use('*', async (c, next) => {
    c.set('platform', makePlatform(c));
    return next();
  });

  app.route('', authRoutes());

  // Site context: explicit header (set by the SDK) beats subdomain; the bare
  // host is the dashboard, which is itself just a site named `home`.
  app.use('*', async (c, next) => {
    const fromHeader = c.req.header('x-brisk-site');
    if (fromHeader && fromHeader !== 'home' && !isValidSiteName(fromHeader)) {
      return c.json({ error: 'invalid x-brisk-site header' }, 400);
    }
    const fromHost = siteFromHost(new URL(c.req.url).host, c.env.BASE_HOST);
    c.set('site', fromHeader || fromHost || 'home');
    return next();
  });

  // Harden the JSON API and auth surfaces: never sniff, never be framed. (User
  // sites are deliberately excluded — serving arbitrary framable HTML is the
  // product; the dashboard assets get their own headers in the catch-all.)
  const denyFrameNoSniff = async (c: Context<AppEnv>, next: () => Promise<void>) => {
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    await next();
  };
  app.use('/api/*', denyFrameNoSniff);
  app.use('/auth/*', denyFrameNoSniff);

  app.use('*', auth());

  // ---- identity ----------------------------------------------------------

  app.get('/api/me', (c) => c.json(c.var.user));

  // Behind the auth gate on purpose: `brisk login` needs the user resolved.
  // GET confirms (consent page for browser sessions); POST mints the token.
  app.get('/auth/cli', cliConsent());
  app.post('/auth/cli', cliMint());

  // ---- database ----------------------------------------------------------

  const publish = (c: Context<AppEnv>, site: string, event: DbEvent) => {
    c.var.platform.waitUntil(c.var.platform.rooms.publish(site, event));
  };

  registerPluginRoutes(app, plugins, publish);

  app.get('/api/db', async (c) => {
    const store = new DocStore(c.var.platform.db);
    return c.json({ collections: await store.collections(c.var.site) });
  });

  app.get('/api/db/:collection', async (c) => {
    const store = new DocStore(c.var.platform.db);
    const docs = await store.list(c.var.site, c.req.param('collection'), {
      limit: Number(c.req.query('limit')) || undefined,
      sort: c.req.query('sort'),
    });
    return c.json({ docs });
  });

  // Plugin-owned collections (`_plugin:*`) are writable only through their
  // plugin's action handlers, which server-stamp the author and keep the audit
  // trail append-only. The generic db routes may read them — the widget
  // subscribes that way — but refuse direct writes, or any teammate could forge
  // an author, hard-delete past the soft-delete, or fabricate audit events. A
  // namespace reservation, not a permission: everyone uses the plugin equally
  // through its actions.
  const isPluginCollection = (name: string) => name.startsWith(PLUGIN_COLLECTION_PREFIX);
  const reservedCollection = (c: Context<AppEnv>) => c.json({ error: 'reserved collection' }, 403);

  app.post('/api/db/:collection', async (c) => {
    const collection = c.req.param('collection');
    if (isPluginCollection(collection)) return reservedCollection(c);
    const fields = await c.req.json<Record<string, unknown>>();
    const doc = await new DocStore(c.var.platform.db).create(c.var.site, collection, fields);
    publish(c, c.var.site, { collection, event: 'create', doc });
    return c.json(doc, 201);
  });

  app.get('/api/db/:collection/:id', async (c) => {
    const doc = await new DocStore(c.var.platform.db).get(
      c.var.site,
      c.req.param('collection'),
      c.req.param('id'),
    );
    return doc ? c.json(doc) : c.json({ error: 'not found' }, 404);
  });

  app.patch('/api/db/:collection/:id', async (c) => {
    const collection = c.req.param('collection');
    if (isPluginCollection(collection)) return reservedCollection(c);
    const fields = await c.req.json<Record<string, unknown>>();
    const doc = await new DocStore(c.var.platform.db).update(
      c.var.site,
      collection,
      c.req.param('id'),
      fields,
    );
    if (!doc) return c.json({ error: 'not found' }, 404);
    publish(c, c.var.site, { collection, event: 'update', doc });
    return c.json(doc);
  });

  app.delete('/api/db/:collection/:id', async (c) => {
    const collection = c.req.param('collection');
    if (isPluginCollection(collection)) return reservedCollection(c);
    const id = c.req.param('id');
    const deleted = await new DocStore(c.var.platform.db).delete(c.var.site, collection, id);
    if (!deleted) return c.json({ error: 'not found' }, 404);
    publish(c, c.var.site, { collection, event: 'delete', id });
    return c.json({ ok: true });
  });

  // ---- file uploads ------------------------------------------------------

  app.post('/api/fs/upload', async (c) => {
    const files = formFiles(await c.req.parseBody({ all: true }));
    if (!files.length) return c.json({ error: 'no files in form field "files"' }, 400);
    if (tooLarge(files.reduce((n, f) => n + f.size, 0))) {
      return c.json({ error: 'upload too large (max 10 MB)' }, 413);
    }

    const uploaded = await Promise.all(
      files.map(async (file) => {
        const id = crypto.randomUUID().slice(0, 8);
        const name = file.name.replaceAll('/', '_') || 'file';
        await c.var.platform.storage.put(`uploads/${c.var.site}/${id}/${name}`, file.stream(), {
          contentType: file.type || contentType(name),
        });
        return {
          name,
          url: `/files/${c.var.site}/${id}/${encodeURIComponent(name)}`,
          size: file.size,
          type: file.type,
        };
      }),
    );
    return c.json({ files: uploaded });
  });

  app.get('/files/:site/:id/:name', async (c) => {
    const { site, id, name } = c.req.param();
    const object = await c.var.platform.storage.get(`uploads/${site}/${id}/${name}`);
    if (!object) return c.notFound();
    const headers = new Headers();
    if (object.contentType) headers.set('content-type', object.contentType);
    headers.set('etag', object.etag);
    headers.set('cache-control', 'public, max-age=31536000, immutable');
    // Uploads carry a client-supplied Content-Type and are served from the apex
    // origin. Never let one render inline as a document: don't sniff, and force
    // a download. Subresource use (<img>, <script src>) is unaffected.
    headers.set('x-content-type-options', 'nosniff');
    headers.set('content-disposition', 'attachment');
    return new Response(object.body, { headers });
  });

  // ---- ai ----------------------------------------------------------------

  app.post('/api/ai/chat', async (c) => {
    const req = await c.req.json().catch(() => null);
    try {
      // A bare string is shorthand for one user message — nice from curl.
      if (typeof req === 'string') {
        return c.json(await chat(c.env, { messages: [{ role: 'user', content: req }] }));
      }
      if (!Array.isArray(req?.messages)) {
        return c.json({ error: 'expected { messages: [...] } or a string' }, 400);
      }
      const { messages, system, model, maxTokens } = req;
      return c.json(await chat(c.env, { messages, system, model, maxTokens }));
    } catch (err) {
      if (err instanceof AiNotConfiguredError) return c.json({ error: err.message }, 501);
      throw err;
    }
  });

  // ---- sites & deploys ---------------------------------------------------

  // The one /api/ route visitors may hit (the dashboard's list). Cache it for
  // them too — uncached it's a full-table D1 read on every anonymous request.
  app.get('/api/sites', async (c) => {
    const res = await visitorCached(
      c,
      async () => {
        const sites = await listSites(c.var.platform);
        return c.json({ sites: sites.map((s) => ({ ...s, url: siteUrl(c, s.name) })) });
      },
      60,
    );
    return res!; // build() never returns null here
  });

  app.get('/api/sites/:name', async (c) => {
    const site = await getSite(c.var.platform, c.req.param('name'));
    return site
      ? c.json({ ...site, url: siteUrl(c, site.name) })
      : c.json({ error: 'not found' }, 404);
  });

  app.get('/api/sites/:name/files', async (c) =>
    c.json({ files: await listFiles(c.var.platform, c.req.param('name')) }),
  );

  // Exact file from a site's live deploy — lets `brisk pull` remix any site.
  app.get('/api/sites/:name/raw/*', async (c) => {
    const name = c.req.param('name');
    const path = new URL(c.req.url).pathname.slice(`/api/sites/${name}/raw/`.length);
    const file = await getFile(c.var.platform, name, decodeURIComponent(path));
    return file ?? c.json({ error: 'not found' }, 404);
  });

  app.delete('/api/sites/:name', async (c) => {
    const existed = await deleteSite(c.var.platform, c.req.param('name'));
    if (!existed) return c.json({ error: 'site not found' }, 404);
    return c.json({ ok: true });
  });

  app.post('/api/deploy/:name', async (c) => {
    const site = c.req.param('name');
    if (!isValidSiteName(site)) {
      return c.json({ error: 'site names are lowercase letters, digits, and dashes' }, 400);
    }
    const files: DeployFile[] = formFiles(await c.req.parseBody({ all: true }))
      .map((file) => ({ path: file.name.replace(/^\/+/, ''), file }))
      .filter(({ path }) => path && !path.split('/').includes('..'));
    if (!files.length) return c.json({ error: 'no files in form field "files"' }, 400);
    if (files.length > MAX_DEPLOY_FILES) {
      return c.json({ error: `too many files (max ${MAX_DEPLOY_FILES})` }, 400);
    }
    if (tooLarge(files.reduce((n, { file }) => n + file.size, 0))) {
      return c.json({ error: 'site too large (max 10 MB)' }, 413);
    }

    // The self-asserted deployer identity (spoofable by design). On AUTH=none
    // everyone is 'Dev', so ownership only has teeth on AUTH=google.
    const who = c.req.header('x-brisk-username') || c.var.user.name || c.var.user.email;
    const force = ['1', 'true'].includes(c.req.query('force') ?? '');
    // A trust-based footgun guard, never a permission: deploying over someone
    // else's site needs an explicit --force. NULL/unowned sites never block.
    const existing = await getSite(c.var.platform, site);
    if (existing?.owner && existing.owner !== who && !force) {
      return c.json(
        {
          error: `site "${site}" is owned by ${existing.owner} — pass --force to overwrite`,
          code: 'owned',
          owner: existing.owner,
        },
        409,
      );
    }

    // Resolve the retention flag here (the route has c.env); deploySite itself
    // is platform-only and takes the decision as a boolean.
    const requested = parseRequestedPlugins(c.req.header('x-brisk-plugins'));
    const enabled = resolveEnabled(plugins, requested);
    const info = await deploySite(
      c.var.platform,
      site,
      files,
      who,
      c.env.DEPLOY_HISTORY === 'on',
      enabled,
    );
    return c.json({ ...info, url: siteUrl(c, site) });
  });

  // ---- realtime ----------------------------------------------------------

  // The websocket route is the one genuinely platform-specific handler: on
  // Cloudflare the upgrade is answered in-band (101 Response); on Node it arrives
  // on the HTTP 'upgrade' event and is handled by an upgradeWebSocket middleware.
  // Cloudflare uses this default; the Node entry passes an override.
  const defaultWsRoute: Handler<AppEnv> = (c) => {
    if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
      return c.json({ error: 'expected a websocket upgrade' }, 426);
    }
    // Browsers can't set headers on websocket connects, so path-mode pages
    // pass their site as a query param instead — validated like the header.
    const fromQuery = c.req.query('site');
    if (fromQuery && !isValidSiteName(fromQuery)) {
      return c.json({ error: 'invalid site' }, 400);
    }
    const site = fromQuery || c.var.site;
    return c.var.platform.rooms.connect(site, c.req.raw, c.var.user);
  };
  app.get('/api/ws', wsRoute ?? defaultWsRoute);

  // ---- static serving ----------------------------------------------------

  const serveSiteFor = (c: Context<AppEnv>, site: string, path: string): Promise<Response | null> =>
    visitorCached(
      c,
      async () => {
        const res = await serveSite(c.var.platform, site, path);
        // Members get widgets; visitors (edge-cached, signed-out) never do — the
        // widget is behind auth, and comments are internal review tooling.
        if (!res || isVisitor(c.var.user)) return res;
        // A legacy site (plugins column NULL) never had a set resolved; fall back
        // to the registry defaults so default-on plugins appear without a
        // re-deploy. An explicit stored [] (opt-out) is respected as-is.
        const stored =
          (await sitePlugins(c.var.platform, site)).plugins ?? resolveEnabled(plugins, {});
        // Fold in any (now-)mandatory plugin the stored set predates, so
        // "mandatory is always on" holds without a redeploy.
        const enabled = withMandatory(plugins, stored);
        return injectWidgets(res, plugins, enabled, site);
      },
      300,
      site,
    );

  // Plugin widget bundles: authed (see visitorAllowed), served from worker
  // assets at /plugins/<id>/widget.js — the one fixed name the widget builder
  // emits. Registered before the catch-all.
  app.get('/_plugins/:id/widget.js', async (c) => {
    const id = c.req.param('id');
    if (!plugins.some((p) => p.id === id && p.widget)) return c.notFound();
    const asset = await c.var.platform.assets.fetch(`/plugins/${id}/widget.js`);
    if (!asset.ok) return c.notFound();
    return securedAsset(asset);
  });

  // Path mode: /s/<site>/... works on any host (workers.dev, local dev).
  app.get('/s/:site/*', async (c) => {
    const site = c.req.param('site');
    const path = new URL(c.req.url).pathname.slice(`/s/${site}`.length);
    const deployed = await serveSiteFor(c, site, path);
    if (deployed) return deployed;
    const exists = Boolean(await getSite(c.var.platform, site));
    return notFoundPage(site, path, exists, `/s/${site}/`);
  });
  app.get('/s/:site', (c) => c.redirect(`/s/${c.req.param('site')}/`));

  // Everything else: serve the request's site. The dashboard ships as worker
  // assets and acts as the default `home` site until someone deploys over it.
  app.get('*', async (c) => {
    const path = new URL(c.req.url).pathname;
    // Static page serving keys off the host (or the /s/<site>/ route above),
    // never the x-brisk-site header. That header is only for SDK API calls;
    // honoring it here let a visitor serve — and cache — another site's content
    // under this URL (cross-site defacement / stored XSS).
    const site = siteFromHost(new URL(c.req.url).host, c.env.BASE_HOST) ?? 'home';

    const deployed = await serveSiteFor(c, site, path);
    if (deployed) return deployed;

    if (site === 'home') {
      const asset = await c.var.platform.assets.fetch(path);
      if (asset.ok) return securedAsset(asset);
    }
    // The SDK is available on every site, deployed or not.
    if (path === '/brisk.js') {
      const asset = await c.var.platform.assets.fetch('/brisk.js');
      if (asset.ok) return securedAsset(asset);
    }
    // `home` is the dashboard, not a deployed site — a miss there is just a bad URL.
    const exists = site !== 'home' && Boolean(await getSite(c.var.platform, site));
    return notFoundPage(site, path, exists, '/');
  });

  return app;
}

/**
 * Dashboard assets (the `home` site UI, docs, brisk.js) are served from the
 * apex origin and hold the session, so they must never be framed or sniffed.
 * Asset responses have immutable headers, so re-wrap to add them.
 */
function securedAsset(asset: Response): Response {
  const headers = new Headers(asset.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Content-Security-Policy', "frame-ancestors 'none'");
  return new Response(asset.body, {
    status: asset.status,
    statusText: asset.statusText,
    headers,
  });
}

/**
 * The catch-all 404, in three shapes — "no such site" and "the site is live but
 * this path isn't" are different answers. Telling someone to `brisk deploy
 * --site X` when X is already live would invite them to overwrite it.
 */
function notFoundPage(site: string, path: string, exists: boolean, root: string): Response {
  const body = exists
    ? `<h1><em>${escapeHtml(site)}</em> is live, but there's no page at <code>${escapeHtml(path)}</code></h1>
<p><a href="${escapeHtml(root)}">← back to ${escapeHtml(site)}</a></p>`
    : site === 'home'
      ? `<h1>Nothing here</h1><p>That page doesn't exist.</p>`
      : `<h1>Nothing at <em>${escapeHtml(site)}</em> yet</h1>
<p>Claim it from any folder:</p><p><code>brisk deploy --site ${escapeHtml(site)}</code></p>`;
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${exists ? 'Page not found' : 'Nothing here yet'}</title>
<style>body{font:16px/1.6 ui-monospace,monospace;display:grid;place-items:center;min-height:100vh;margin:0;background:#0c0c0f;color:#e8e6e0}main{text-align:center;padding:2rem}h1{font-size:1.4rem}code{background:#1c1c22;padding:.2em .5em;border-radius:6px;color:#9ee493}a{color:#9ee493}</style>
<main>${body}</main>`,
    { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
