import { SELF, createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { buildCloudflarePlatform } from '../src/platform/cloudflare/platform';
import type { AppEnv } from '../src/env';
import type { Context } from 'hono';
import { comments } from '../src/plugins/comments';
import { resolveEnabled } from '../src/plugins/resolve';
import { toManifest, type Plugin } from '../src/plugins/types';

const cfMake = (c: Context<AppEnv>) => buildCloudflarePlatform(c.env, c.executionCtx);

const p = (id: string, requirement: Plugin['requirement']): Plugin => ({
  id,
  name: id,
  description: `${id} plugin`,
  requirement,
});

const registry: Plugin[] = [p('mand', 'mandatory'), p('def', 'default'), p('opt', 'optional')];

describe('resolveEnabled', () => {
  it('applies requirement defaults when nothing is requested', () => {
    expect(resolveEnabled(registry, {}).sort()).toEqual(['def', 'mand']);
  });

  it('lets requests toggle default/optional but never mandatory', () => {
    expect(resolveEnabled(registry, { mand: false, def: false, opt: true }).sort()).toEqual([
      'mand',
      'opt',
    ]);
  });

  it('ignores unknown requested ids', () => {
    expect(resolveEnabled(registry, { ghost: true }).sort()).toEqual(['def', 'mand']);
  });
});

describe('toManifest', () => {
  it('drops handlers and fills action defaults', () => {
    const plugin: Plugin = {
      id: 'echo',
      name: 'Echo',
      description: 'test',
      requirement: 'default',
      widget: 'widget.js',
      actions: {
        say: {
          summary: 'echo it back',
          args: [{ name: 'message', required: true }],
          render: 'text',
          handler: async (_ctx, args) => args.message,
        },
      },
    };
    const manifest = toManifest(plugin);
    expect(manifest.actions.say).toEqual({
      summary: 'echo it back',
      args: [{ name: 'message', required: true }],
      render: 'text',
    });
    expect('handler' in manifest.actions.say).toBe(false);
    expect(manifest.widget).toBe('widget.js');
  });
});

describe('enablement persists per site', () => {
  const deploy = (name: string, plugins?: Record<string, boolean>) => {
    const form = new FormData();
    form.append('files', new File(['<h1>x</h1>'], 'index.html', { type: 'text/html' }));
    return SELF.fetch(`http://localhost/api/deploy/${name}`, {
      method: 'POST',
      headers: plugins ? { 'x-brisk-plugins': JSON.stringify(plugins) } : {},
      body: form,
    });
  };

  it('stores the resolved enabled set and echoes it on the site', async () => {
    // Deploy with comments explicitly OFF so the expected set is [] whether or
    // not the real registry has the (default-on) comments plugin — keeps this
    // round-trip test stable once comments is registered in Phase 2.
    const res = await deploy('plug-a', { comments: false });
    expect(res.status).toBe(200);
    expect(await res.json<{ plugins: string[] }>()).toMatchObject({ plugins: [] });

    const site = await (
      await SELF.fetch('http://localhost/api/sites/plug-a')
    ).json<{
      plugins: string[];
    }>();
    expect(site.plugins).toEqual([]);
  });
});

const fixture: Plugin = {
  id: 'echo',
  name: 'Echo',
  description: 'echoes arguments back',
  requirement: 'default',
  widget: 'widget.js',
  actions: {
    say: {
      summary: 'echo a message',
      args: [{ name: 'message', required: true }],
      render: 'text',
      handler: async (_ctx, args) => `you said: ${args.message}`,
    },
  },
};

const fixtureApp = createApp(cfMake, undefined, [fixture]);
const call = (path: string, init?: RequestInit) => {
  const ctx = createExecutionContext();
  return fixtureApp
    .fetch(new Request(`http://localhost${path}`, init), env, ctx)
    .then(async (res) => {
      await waitOnExecutionContext(ctx);
      return res;
    });
};

describe('plugin API', () => {
  it('lists installed plugins', async () => {
    const res = await call('/api/plugins');
    expect(await res.json()).toEqual({
      plugins: [
        { id: 'echo', name: 'Echo', description: 'echoes arguments back', requirement: 'default' },
      ],
    });
  });

  it('serves a manifest without leaking the handler', async () => {
    const manifest = await (
      await call('/api/plugins/echo')
    ).json<{ actions: Record<string, unknown> }>();
    expect(manifest.actions.say).toMatchObject({ summary: 'echo a message', render: 'text' });
    expect(JSON.stringify(manifest)).not.toContain('handler');
  });

  it('404s an unknown plugin', async () => {
    expect((await call('/api/plugins/ghost')).status).toBe(404);
  });

  it('runs an action and returns its result', async () => {
    const res = await call('/api/plugins/echo/actions/say', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: { message: 'hi' } }),
    });
    expect(await res.json()).toEqual({ result: 'you said: hi' });
  });

  it('400s a missing required argument', async () => {
    const res = await call('/api/plugins/echo/actions/say', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: {} }),
    });
    expect(res.status).toBe(400);
    expect(await res.json<{ error: string }>()).toMatchObject({
      error: expect.stringContaining('message'),
    });
  });

  it('404s an unknown action and lists the real ones', async () => {
    const res = await call('/api/plugins/echo/actions/nope', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: {} }),
    });
    expect(res.status).toBe(404);
    expect(await res.json<{ actions: string[] }>()).toMatchObject({ actions: ['say'] });
  });
});

describe('widget injection', () => {
  const deployHtml = (name: string, html: string) => {
    const form = new FormData();
    form.append('files', new File([html], 'index.html', { type: 'text/html' }));
    form.append('files', new File(['body{}'], 'style.css', { type: 'text/css' }));
    const ctx = createExecutionContext();
    return fixtureApp
      .fetch(
        new Request(`http://localhost/api/deploy/${name}`, { method: 'POST', body: form }),
        env,
        ctx,
      )
      .then(async (res) => {
        await waitOnExecutionContext(ctx);
        return res;
      });
  };

  it('appends the enabled widget tag to HTML pages for members', async () => {
    await deployHtml('wtest', '<!doctype html><html><body><h1>hi</h1></body></html>');
    const page = await call('/s/wtest/');
    const html = await page.text();
    expect(html).toContain('<script src="/_plugins/echo/widget.js"');
    expect(html).toContain('data-brisk-site="wtest"');
    expect(html).toContain('<h1>hi</h1>');
  });

  it('does not touch non-HTML assets', async () => {
    await deployHtml('wtest2', '<!doctype html><html><body>x</body></html>');
    const css = await call('/s/wtest2/style.css');
    expect(await css.text()).toBe('body{}');
  });

  it('falls back to registry defaults on a legacy site (plugins column NULL)', async () => {
    // A site from before the plugins column existed: a live deploy pointer, but
    // plugins NULL. Default-on widgets should still inject without a re-deploy.
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO sites (name, active_deploy, files, bytes, created_at, updated_at, updated_by, owner, plugins)
       VALUES ('legacyui', 'seed', 1, 1, ?, ?, 'old', NULL, NULL)`,
    )
      .bind(now, now)
      .run();
    await env.BUCKET.put(
      'deploys/legacyui/seed/index.html',
      '<!doctype html><html><body>legacy</body></html>',
      { httpMetadata: { contentType: 'text/html' } },
    );
    const html = await (await call('/s/legacyui/')).text();
    expect(html).toContain('/_plugins/echo/widget.js');
  });

  it('respects an explicit empty set (opt-out is not treated as legacy)', async () => {
    const form = new FormData();
    form.append(
      'files',
      new File(['<!doctype html><html><body>x</body></html>'], 'index.html', {
        type: 'text/html',
      }),
    );
    const ctx = createExecutionContext();
    await fixtureApp.fetch(
      new Request('http://localhost/api/deploy/optout', {
        method: 'POST',
        headers: { 'x-brisk-plugins': JSON.stringify({ echo: false }) },
        body: form,
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const html = await (await call('/s/optout/')).text();
    expect(html).not.toContain('/_plugins/echo/widget.js');
  });
});

describe('widget auth gate', () => {
  const publicEnv = {
    ...env,
    AUTH: 'google' as const,
    VISIBILITY: 'public' as const,
    SESSION_SECRET: 'test-secret',
    DEPLOY_TOKEN: 'ci-token',
  };
  const asEnv = (authEnv: typeof env, path: string, init?: RequestInit) => {
    const ctx = createExecutionContext();
    return fixtureApp
      .fetch(new Request(`http://localhost${path}`, init), authEnv, ctx)
      .then(async (res) => {
        await waitOnExecutionContext(ctx);
        return res;
      });
  };

  it('blocks the bundle and omits the tag for signed-out visitors', async () => {
    const form = new FormData();
    form.append(
      'files',
      new File(['<!doctype html><html><body>hi</body></html>'], 'index.html', {
        type: 'text/html',
      }),
    );
    await asEnv(publicEnv, '/api/deploy/demo', {
      method: 'POST',
      headers: { authorization: 'Bearer ci-token' },
      body: form,
    });

    const visitorPage = await asEnv(publicEnv, '/s/demo/');
    expect(await visitorPage.text()).not.toContain('/_plugins/echo/widget.js');

    const bundle = await asEnv(publicEnv, '/_plugins/echo/widget.js');
    expect(bundle.status).toBe(401);
  });
});

const commentsApp = createApp(cfMake, undefined, [comments]);
const cc = (path: string, init?: RequestInit) => {
  const ctx = createExecutionContext();
  return commentsApp
    .fetch(new Request(`http://localhost${path}`, init), env, ctx)
    .then(async (res) => {
      await waitOnExecutionContext(ctx);
      return res;
    });
};
const act = async (name: string, args: Record<string, string>) =>
  (
    await cc(`/api/plugins/comments/actions/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args }),
    })
  ).json<{ result: Record<string, unknown> }>();

describe('comments write actions', () => {
  it('creates a comment with a server-stamped author, ignoring a forged one', async () => {
    const { result } = await act('create', {
      site: 'csite',
      text: 'fix this heading',
      page: '/',
      selector: 'h1',
      createdBy: 'not-me',
    });
    expect(result).toMatchObject({
      text: 'fix this heading',
      createdBy: 'Dev',
      resolved: false,
      deleted: false,
    });
    expect(result.createdBy).not.toBe('not-me');
  });

  it('records an append-only event per mutation', async () => {
    const { result: c } = await act('create', { site: 'evsite', text: 'hi' });
    await act('resolve', { site: 'evsite', id: String(c.id) });
    const events = await (
      await cc('/api/db/_plugin:comments:events', { headers: { 'x-brisk-site': 'evsite' } })
    ).json<{ docs: { commentId: string; action: string; by: string }[] }>();
    const forThis = events.docs.filter((e) => e.commentId === c.id).map((e) => e.action);
    expect(forThis).toContain('create');
    expect(forThis).toContain('resolve');
  });

  it('soft-deletes rather than destroying the record', async () => {
    const { result: c } = await act('create', { site: 'dsite', text: 'temp' });
    const { result: d } = await act('delete', { site: 'dsite', id: String(c.id) });
    expect(d).toMatchObject({ deleted: true, deletedBy: 'Dev' });
    const still = await (
      await cc(`/api/db/_plugin:comments/${c.id}`, { headers: { 'x-brisk-site': 'dsite' } })
    ).json<{ deleted: boolean }>();
    expect(still.deleted).toBe(true);
  });
});

describe('comments read actions', () => {
  it('lists top-level comments filtered by status', async () => {
    const { result: open } = await act('create', { site: 'rsite', text: 'open one' });
    const { result: done } = await act('create', { site: 'rsite', text: 'done one' });
    await act('resolve', { site: 'rsite', id: String(done.id) });
    await act('reply', { site: 'rsite', id: String(open.id), text: 'a reply' });

    const listed = await act('list', { site: 'rsite', status: 'open' });
    const rows = listed.result as unknown as { id: string; status: string; text: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'open', text: 'open one' });

    const all = (await act('list', { site: 'rsite', status: 'all' }))
      .result as unknown as unknown[];
    expect(all.length).toBe(2);
  });

  it('exports matching comments as markdown', async () => {
    const { result: c } = await act('create', {
      site: 'xsite',
      text: 'sentence-case this',
      page: '/about',
      selector: 'main > h2',
    });
    const md = (await act('export', { site: 'xsite' })).result as unknown as string;
    expect(md).toContain('sentence-case this');
    expect(md).toContain('main > h2');
    expect(md).toContain(String(c.id));
  });

  it('shows a comment history trail', async () => {
    const { result: c } = await act('create', { site: 'hsite', text: 'x' });
    await act('resolve', { site: 'hsite', id: String(c.id) });
    await act('reopen', { site: 'hsite', id: String(c.id) });
    const hist = (await act('history', { site: 'hsite', id: String(c.id) })).result as unknown as {
      action: string;
    }[];
    expect(hist.map((h) => h.action)).toEqual(['create', 'resolve', 'reopen']);
  });
});

describe('registry', () => {
  it('installs comments by default', async () => {
    const res = await SELF.fetch('http://localhost/api/plugins');
    const { plugins } = await res.json<{ plugins: { id: string }[] }>();
    expect(plugins.map((p) => p.id)).toContain('comments');
  });
});
