import { Hono } from 'hono';
import { AiNotConfiguredError, chat } from './ai';
import { auth, authRoutes } from './auth';
import { DocStore } from './docs';
import { contentType } from './mime';
import {
  deploySite,
  getFile,
  getSite,
  isValidSiteName,
  listFiles,
  listSites,
  removeSite,
  serveSite,
  type DeployFile,
} from './sites';
import type { AppEnv, Env } from './env';

const MAX_DEPLOY_FILES = 2000;

/** `foo.brisk.example.com` → `foo`. Also supports `foo.localhost` in dev. */
export function siteFromHost(host: string, baseHost: string): string | null {
  const bare = host.split(':')[0]!.toLowerCase();
  const base = (baseHost.split(':')[0] || 'localhost').toLowerCase();
  if (bare === base) return null;
  if (!bare.endsWith(`.${base}`)) return null;
  const label = bare.slice(0, -(base.length + 1));
  return label.includes('.') ? null : label;
}

function siteUrl(c: { env: Env; req: { url: string } }, site: string): string {
  const url = new URL(c.req.url);
  const base = c.env.BASE_HOST;
  return base ? `${url.protocol}//${site}.${base}/` : `${url.protocol}//${url.host}/s/${site}/`;
}

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.route('', authRoutes());

  // Site context: explicit header (set by the SDK) beats subdomain; the bare
  // host is the dashboard, which is itself just a site named `home`.
  app.use('*', async (c, next) => {
    const fromHeader = c.req.header('x-brisk-site');
    const fromHost = siteFromHost(new URL(c.req.url).host, c.env.BASE_HOST);
    c.set('site', fromHeader || fromHost || 'home');
    return next();
  });

  app.use('*', auth());

  // ---- identity ----------------------------------------------------------

  app.get('/api/me', (c) => c.json(c.var.user));

  // ---- database ----------------------------------------------------------

  const publish = (
    c: { env: Env; executionCtx: ExecutionContext },
    site: string,
    event: object,
  ) => {
    const room = c.env.ROOMS.get(c.env.ROOMS.idFromName(site));
    c.executionCtx.waitUntil(
      room.fetch('https://room/publish', { method: 'POST', body: JSON.stringify(event) }),
    );
  };

  app.get('/api/db', async (c) => {
    const store = new DocStore(c.env.DB);
    return c.json({ collections: await store.collections(c.var.site) });
  });

  app.get('/api/db/:collection', async (c) => {
    const store = new DocStore(c.env.DB);
    const docs = await store.list(c.var.site, c.req.param('collection'), {
      limit: Number(c.req.query('limit')) || undefined,
      sort: c.req.query('sort'),
    });
    return c.json({ docs });
  });

  app.post('/api/db/:collection', async (c) => {
    const collection = c.req.param('collection');
    const fields = await c.req.json<Record<string, unknown>>();
    const doc = await new DocStore(c.env.DB).create(c.var.site, collection, fields);
    publish(c, c.var.site, { collection, event: 'create', doc });
    return c.json(doc, 201);
  });

  app.get('/api/db/:collection/:id', async (c) => {
    const doc = await new DocStore(c.env.DB).get(
      c.var.site,
      c.req.param('collection'),
      c.req.param('id'),
    );
    return doc ? c.json(doc) : c.json({ error: 'not found' }, 404);
  });

  app.patch('/api/db/:collection/:id', async (c) => {
    const collection = c.req.param('collection');
    const fields = await c.req.json<Record<string, unknown>>();
    const doc = await new DocStore(c.env.DB).update(
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
    const id = c.req.param('id');
    const deleted = await new DocStore(c.env.DB).delete(c.var.site, collection, id);
    if (!deleted) return c.json({ error: 'not found' }, 404);
    publish(c, c.var.site, { collection, event: 'delete', id });
    return c.json({ ok: true });
  });

  // ---- file uploads ------------------------------------------------------

  app.post('/api/fs/upload', async (c) => {
    const body = await c.req.parseBody({ all: true });
    const raw = body['files'] ?? body['file'];
    const files = (Array.isArray(raw) ? raw : [raw]).filter((f): f is File => f instanceof File);
    if (!files.length) return c.json({ error: 'no files in form field "files"' }, 400);

    const uploaded = await Promise.all(
      files.map(async (file) => {
        const id = crypto.randomUUID().slice(0, 8);
        const name = file.name.replaceAll('/', '_') || 'file';
        await c.env.BUCKET.put(`uploads/${c.var.site}/${id}/${name}`, file.stream(), {
          httpMetadata: { contentType: file.type || contentType(name) },
        });
        return {
          name,
          url: `/files/${c.var.site}/${id}/${name}`,
          size: file.size,
          type: file.type,
        };
      }),
    );
    return c.json({ files: uploaded });
  });

  app.get('/files/:site/:id/:name', async (c) => {
    const { site, id, name } = c.req.param();
    const object = await c.env.BUCKET.get(`uploads/${site}/${id}/${name}`);
    if (!object) return c.notFound();
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('cache-control', 'public, max-age=31536000, immutable');
    return new Response(object.body, { headers });
  });

  // ---- ai ----------------------------------------------------------------

  app.post('/api/ai/chat', async (c) => {
    try {
      const req = await c.req.json();
      // Accept both a bare string and a messages array, Quick-style ergonomics.
      const messages =
        typeof req === 'string'
          ? [{ role: 'user' as const, content: req }]
          : Array.isArray(req)
            ? req
            : (req.messages ?? [{ role: 'user' as const, content: String(req.content ?? '') }]);
      const opts = typeof req === 'object' && !Array.isArray(req) ? req : {};
      return c.json(await chat(c.env, { ...opts, messages }));
    } catch (err) {
      if (err instanceof AiNotConfiguredError) return c.json({ error: err.message }, 501);
      throw err;
    }
  });

  // ---- sites & deploys ---------------------------------------------------

  app.get('/api/sites', async (c) => {
    const sites = await listSites(c.env);
    return c.json({ sites: sites.map((s) => ({ ...s, url: siteUrl(c, s.name) })) });
  });

  app.get('/api/sites/:name', async (c) => {
    const site = await getSite(c.env, c.req.param('name'));
    return site
      ? c.json({ ...site, url: siteUrl(c, site.name) })
      : c.json({ error: 'not found' }, 404);
  });

  app.get('/api/sites/:name/files', async (c) =>
    c.json({ files: await listFiles(c.env, c.req.param('name')) }),
  );

  // Exact file from a site's live deploy — lets `brisk pull` remix any site.
  app.get('/api/sites/:name/raw/*', async (c) => {
    const name = c.req.param('name');
    const path = new URL(c.req.url).pathname.slice(`/api/sites/${name}/raw/`.length);
    const file = await getFile(c.env, name, decodeURIComponent(path));
    return file ?? c.json({ error: 'not found' }, 404);
  });

  app.delete('/api/sites/:name', async (c) => {
    await removeSite(c.env, c.req.param('name'));
    return c.json({ ok: true });
  });

  app.post('/api/deploy/:site', async (c) => {
    const site = c.req.param('site');
    if (!isValidSiteName(site)) {
      return c.json({ error: 'site names are lowercase letters, digits, and dashes' }, 400);
    }
    const body = await c.req.parseBody({ all: true });
    const raw = body['files'];
    const files: DeployFile[] = (Array.isArray(raw) ? raw : [raw])
      .filter((f): f is File => f instanceof File)
      .map((file) => ({ path: file.name.replace(/^\/+/, ''), file }))
      .filter(({ path }) => path && !path.split('/').includes('..'));
    if (!files.length) return c.json({ error: 'no files in form field "files"' }, 400);
    if (files.length > MAX_DEPLOY_FILES) {
      return c.json({ error: `too many files (max ${MAX_DEPLOY_FILES})` }, 400);
    }

    const info = await deploySite(c.env, c.executionCtx, site, files, c.var.user);
    return c.json({ ...info, url: siteUrl(c, site) });
  });

  // ---- realtime ----------------------------------------------------------

  app.get('/api/ws', (c) => {
    if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
      return c.json({ error: 'expected a websocket upgrade' }, 426);
    }
    const headers = new Headers(c.req.raw.headers);
    headers.set('x-brisk-user', JSON.stringify(c.var.user));
    // Browsers can't set headers on websocket connects, so path-mode pages
    // pass their site as a query param instead.
    const site = c.req.query('site') || c.var.site;
    const room = c.env.ROOMS.get(c.env.ROOMS.idFromName(site));
    return room.fetch(new Request(c.req.raw.url, { headers }));
  });

  // ---- static serving ----------------------------------------------------

  // Path mode: /s/<site>/... works on any host (workers.dev, local dev).
  app.get('/s/:site/*', async (c) => {
    const site = c.req.param('site');
    const path = new URL(c.req.url).pathname.slice(`/s/${site}`.length);
    return (await serveSite(c.env, site, path)) ?? notFoundPage(site);
  });
  app.get('/s/:site', (c) => c.redirect(`/s/${c.req.param('site')}/`));

  // Everything else: serve the request's site. The dashboard ships as worker
  // assets and acts as the default `home` site until someone deploys over it.
  app.get('*', async (c) => {
    const path = new URL(c.req.url).pathname;
    const site = c.var.site;

    const deployed = await serveSite(c.env, site, path);
    if (deployed) return deployed;

    if (site === 'home') {
      const asset = await c.env.ASSETS.fetch(new URL(path, 'https://assets.local'));
      if (asset.ok) return asset;
    }
    // The SDK is available on every site, deployed or not.
    if (path === '/brisk.js') {
      const asset = await c.env.ASSETS.fetch(new URL('/brisk.js', 'https://assets.local'));
      if (asset.ok) return asset;
    }
    return notFoundPage(site);
  });

  return app;
}

function notFoundPage(site: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Nothing here yet</title>
<style>body{font:16px/1.6 ui-monospace,monospace;display:grid;place-items:center;min-height:100vh;margin:0;background:#0c0c0f;color:#e8e6e0}main{text-align:center;padding:2rem}h1{font-size:1.4rem}code{background:#1c1c22;padding:.2em .5em;border-radius:6px;color:#9ee493}</style>
<main><h1>Nothing at <em>${escapeHtml(site)}</em> yet</h1>
<p>Claim it from any folder:</p><p><code>brisk deploy --site ${escapeHtml(site)}</code></p></main>`,
    { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
