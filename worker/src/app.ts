import { Hono } from 'hono';
import { AiNotConfiguredError, chat } from './ai';
import { auth, authRoutes, cliAuthRoute, isVisitor } from './auth';
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
  type DeployFile,
} from './sites';
import type { DbEvent } from './room';
import type { AppEnv, Env, User } from './env';

const MAX_DEPLOY_FILES = 2000;

/** Every File in the form's `files` field, whatever Hono parsed it into. */
function formFiles(body: Record<string, unknown>): File[] {
  const raw = body['files'];
  return (Array.isArray(raw) ? raw : [raw]).filter((f): f is File => f instanceof File);
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

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

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

  app.use('*', auth());

  // ---- identity ----------------------------------------------------------

  app.get('/api/me', (c) => c.json(c.var.user));

  // Behind the auth gate on purpose: `brisk login` needs the user resolved.
  app.get('/auth/cli', cliAuthRoute());

  // ---- database ----------------------------------------------------------

  const publish = (
    c: { env: Env; executionCtx: ExecutionContext },
    site: string,
    event: DbEvent,
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
    const files = formFiles(await c.req.parseBody({ all: true }));
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
    const existed = await deleteSite(c.env, c.req.param('name'));
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

  // Visitors on a public instance get edge-cached responses, so a busy demo
  // costs ~zero R2/D1 operations. Members always see fresh deploys.
  const serveSiteFor = async (
    c: { env: Env; executionCtx: ExecutionContext; req: { raw: Request }; var: { user: User } },
    site: string,
    path: string,
  ): Promise<Response | null> => {
    if (!isVisitor(c.var.user)) return serveSite(c.env, site, path);
    const key = new Request(c.req.raw.url, { method: 'GET' });
    const cache = caches.default;
    const hit = await cache.match(key);
    if (hit) return hit;
    const res = await serveSite(c.env, site, path);
    if (!res) return null;
    // Buffer the body so the cached copy doesn't keep the R2 stream open.
    const body = await res.arrayBuffer();
    const headers = new Headers(res.headers);
    headers.set('cache-control', 'public, max-age=300');
    c.executionCtx.waitUntil(cache.put(key, new Response(body.slice(0), { headers })));
    return new Response(body, { headers });
  };

  // Path mode: /s/<site>/... works on any host (workers.dev, local dev).
  app.get('/s/:site/*', async (c) => {
    const site = c.req.param('site');
    const path = new URL(c.req.url).pathname.slice(`/s/${site}`.length);
    return (await serveSiteFor(c, site, path)) ?? notFoundPage(site);
  });
  app.get('/s/:site', (c) => c.redirect(`/s/${c.req.param('site')}/`));

  // Everything else: serve the request's site. The dashboard ships as worker
  // assets and acts as the default `home` site until someone deploys over it.
  app.get('*', async (c) => {
    const path = new URL(c.req.url).pathname;
    const site = c.var.site;

    const deployed = await serveSiteFor(c, site, path);
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
